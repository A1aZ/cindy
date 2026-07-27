/**
 * sessionsUpdate.test.ts — `local-db:sessions:update` handler 集成接线。
 * -------------------------------------------------------------------
 * 覆盖持久化后需要广播的增量字段，以及会话移动触发 CLI 转录迁移的边界：
 * workingDir 实际变化、且会话是本机 cc 会话时，必须在查询返回行之前调用
 * relocateClaudeTranscriptsForSessionMove(旧值 → 新值)，并把迁移中持久化的最新
 * sdkSessionId 并入返回行与广播 patch；其它会话或未实际移动时不得调用。
 *
 * 另覆盖 IM 绑定的「本地移动授权」登记:目录真的变了才登记(hook 侧据此在工作
 * 目录映射外继续复用该会话,见 hook-control/bindings.ts),归一化写法差异不算。
 *
 * 通过 mock electron ipcMain 捕获真实 handler + 内存 sqlite 全列 sessions 表做集成断言。
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { messages, sessions } from '../../schema';

const h = vi.hoisted(() => ({
  db: null as ReturnType<typeof drizzle> | null,
  sqlite: null as InstanceType<typeof import('better-sqlite3')> | null,
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  relocate: vi.fn(async (): Promise<{ persistedSdkSessionId: string | null }> => ({
    persistedSdkSessionId: null,
  })),
  noteHookSessionMoved: vi.fn(async () => undefined),
  isKnownRecentWorkdir: vi.fn(async () => true),
  assertTrustedAppRendererEvent: vi.fn(),
  moveOrder: [] as string[],
  tapWindowBroadcast: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      h.handlers.set(channel, handler);
    }),
  },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../../../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../client/current', () => ({
  getDbClient: () => ({ drizzle: h.db }),
}));
vi.mock('../../dialogueWorkspace', () => ({ ensureDialogueWorkspaceDir: vi.fn() }));
vi.mock('../../../git-context/prRefsStore', () => ({
  recomputePrRefsForSession: vi.fn(async () => undefined),
}));
vi.mock('../../../imageCacheStore', () => ({ removeSession: vi.fn(async () => undefined) }));
vi.mock('../recentWorkdirs', () => ({
  upsertRecentWorkdir: vi.fn(async () => undefined),
  isKnownRecentWorkdir: h.isKnownRecentWorkdir,
}));
vi.mock('../../../security/trustedAppRenderer.js', () => ({
  assertTrustedAppRendererEvent: h.assertTrustedAppRendererEvent,
}));
vi.mock('../../../device-link/broadcast-tap.js', () => ({
  tapWindowBroadcast: h.tapWindowBroadcast,
}));
vi.mock('../../agentIslandSessionPatch', () => ({ notifyAgentIslandSessionPatch: vi.fn() }));
vi.mock('../../../messagePersistBroadcaster', () => ({ noteSessionClearBoundary: vi.fn() }));
vi.mock('../../../sessionIds', () => ({ resolveBusinessSessionId: (id: string) => id }));
vi.mock('../../../maker-host/claude-transcript-relocation.js', () => ({
  relocateClaudeTranscriptsForSessionMove: h.relocate,
}));
vi.mock('../../../hook-control/sessionMoves.js', () => ({
  noteHookSessionMoved: h.noteHookSessionMoved,
}));

import { registerSessionIpc } from '../sessions';

function createDb(): void {
  const sqlite = new Database(':memory:');
  // 与 schema.ts 的 sessions/messages 全列对齐(selectSessionWithCount select 全列)。
  sqlite.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY NOT NULL,
      title TEXT NOT NULL DEFAULT 'New CCS',
      working_dir TEXT,
      model TEXT NOT NULL DEFAULT 'claude-sonnet-4-6',
      effort TEXT NOT NULL DEFAULT 'high',
      permission_mode TEXT NOT NULL DEFAULT 'ask',
      status TEXT NOT NULL DEFAULT 'active',
      sdk_session_id TEXT,
      total_token_usage INTEGER NOT NULL DEFAULT 0,
      total_cost_usd REAL NOT NULL DEFAULT 0,
      total_cost_amount REAL NOT NULL DEFAULT 0,
      total_cost_currency TEXT,
      total_cost_is_approximate INTEGER NOT NULL DEFAULT 0,
      context_tokens INTEGER NOT NULL DEFAULT 0,
      context_window INTEGER NOT NULL DEFAULT 0,
      fast_mode INTEGER NOT NULL DEFAULT 0,
      cleared_at INTEGER,
      pinned_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      agent_kind TEXT NOT NULL DEFAULT 'cc',
      user_send_at INTEGER,
      parent_session_id TEXT,
      forked_at_message_id TEXT,
      worktree_path TEXT,
      source TEXT NOT NULL DEFAULT 'desktop',
      feishu_open_id TEXT,
      feishu_bot_app_id TEXT,
      used_project_context INTEGER NOT NULL DEFAULT 0,
      extra_dirs TEXT NOT NULL DEFAULT '[]',
      one_m INTEGER NOT NULL DEFAULT 0,
      workspace_kind TEXT NOT NULL DEFAULT 'project',
      orca_role TEXT,
      remote_host_id TEXT,
      codex_history_has_product_prompt INTEGER,
      im_bot_context_id TEXT,
      im_user_id TEXT,
      summary TEXT,
      provider_id TEXT,
      plan_mode_enabled INTEGER NOT NULL DEFAULT 0,
      active_turn_started_at INTEGER,
      active_turn_pid INTEGER,
      last_turn_ended_at INTEGER
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      tool_use_id TEXT,
      agent_meta TEXT,
      created_at INTEGER NOT NULL,
      rewind_at INTEGER
    );
  `);
  const insert = sqlite.prepare(`
    INSERT INTO sessions (id, working_dir, agent_kind, remote_host_id, workspace_kind, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, 1)
  `);
  insert.run('cc-local', '/old/dir', 'cc', null, 'dialogue');
  insert.run('codex-local', '/old/dir', 'codex', null, 'dialogue');
  insert.run('cc-remote', '/remote/dir', 'cc', 'host-1', 'project');
  h.sqlite = sqlite;
  h.db = drizzle(sqlite, { schema: { messages, sessions } });
}

async function invokeUpdate(id: string, patch: Record<string, unknown>): Promise<unknown> {
  const handler = h.handlers.get('local-db:sessions:update');
  if (!handler) throw new Error('update handler not registered');
  return handler({}, id, patch);
}

async function invokeMove(id: string, target: Record<string, unknown>): Promise<unknown> {
  const handler = h.handlers.get('local-db:sessions:move');
  if (!handler) throw new Error('move handler not registered');
  return handler({}, id, target);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.moveOrder = [];
  h.isKnownRecentWorkdir.mockImplementation(async () => true);
  h.assertTrustedAppRendererEvent.mockImplementation(() => undefined);
  h.noteHookSessionMoved.mockImplementation(async () => undefined);
  h.relocate.mockImplementation(async () => ({ persistedSdkSessionId: null }));
  h.handlers.clear();
  createDb();
  registerSessionIpc();
});

describe('local-db:sessions:update handler wiring', () => {
  it('persists and broadcasts title-only patches to device-link subscribers', async () => {
    await invokeUpdate('codex-local', { title: '排查远程标题同步' });

    const persisted = h
      .sqlite!.prepare('SELECT title FROM sessions WHERE id = ?')
      .get('codex-local') as { title: string };
    expect(persisted.title).toBe('排查远程标题同步');
    expect(h.tapWindowBroadcast).toHaveBeenCalledWith(
      'local-db:sessions:patched',
      expect.objectContaining({
        sessionId: 'codex-local',
        patch: expect.objectContaining({ title: '排查远程标题同步' }),
      }),
    );
  });

  it('broadcasts permission setting patches to every mounted client', async () => {
    await invokeUpdate('codex-local', { permissionMode: 'ask' });

    expect(h.tapWindowBroadcast).toHaveBeenCalledWith(
      'local-db:sessions:patched',
      expect.objectContaining({
        sessionId: 'codex-local',
        patch: { permissionMode: 'ask' },
      }),
    );
  });

  it('relocates transcripts when workingDir actually changes on a local cc session', async () => {
    await invokeUpdate('cc-local', { workingDir: '/new/dir', workspaceKind: 'project' });

    expect(h.relocate).toHaveBeenCalledTimes(1);
    expect(h.relocate).toHaveBeenCalledWith('cc-local', '/old/dir', '/new/dir');
  });

  it('returns and broadcasts the sdkSessionId persisted during relocation', async () => {
    const liveId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    // 模拟真实编排:迁移把内存 id 持久化进 DB 并上报;handler 必须在迁移后才查
    // 返回行,并把该 id 并入广播 patch,renderer 才不会留着旧 resume id。
    h.relocate.mockImplementation(async () => {
      h.sqlite!.prepare('UPDATE sessions SET sdk_session_id = ? WHERE id = ?').run(
        liveId,
        'cc-local',
      );
      return { persistedSdkSessionId: liveId };
    });

    const updated = (await invokeUpdate('cc-local', {
      workingDir: '/new/dir',
      workspaceKind: 'project',
    })) as { sdkSessionId: string | null };

    expect(updated.sdkSessionId).toBe(liveId);
    expect(h.tapWindowBroadcast).toHaveBeenCalledWith(
      'local-db:sessions:patched',
      expect.objectContaining({
        sessionId: 'cc-local',
        patch: expect.objectContaining({ sdkSessionId: liveId }),
      }),
    );
  });

  it('does nothing when the patched workingDir equals the current one', async () => {
    await invokeUpdate('cc-local', { workingDir: '/old/dir' });
    expect(h.relocate).not.toHaveBeenCalled();
  });

  it('does nothing when a legacy Windows spelling normalizes to the patched workingDir', async () => {
    h.sqlite!.prepare('UPDATE sessions SET working_dir = ? WHERE id = ?').run(
      'D:\\repo\\project',
      'cc-local',
    );

    await invokeUpdate('cc-local', { workingDir: 'D:/repo/project' });

    expect(h.relocate).not.toHaveBeenCalled();
  });

  it('does nothing when the patch has no workingDir (move back to dialogue)', async () => {
    await invokeUpdate('cc-local', { workspaceKind: 'dialogue' });
    expect(h.relocate).not.toHaveBeenCalled();
  });

  it('does nothing for codex sessions', async () => {
    await invokeUpdate('codex-local', { workingDir: '/new/dir' });
    expect(h.relocate).not.toHaveBeenCalled();
  });

  it('does nothing for remote sessions', async () => {
    await invokeUpdate('cc-remote', { workingDir: '/new/dir' });
    expect(h.relocate).not.toHaveBeenCalled();
  });

  it('never mints move authority from the generic update IPC', async () => {
    // 通用 patch 通道是不可信 Renderer 也能调的(preload 直接暴露),
    // 它改 workingDir 只写库,绝不铸造 IM 绑定授权 —— 这正是 #669 要堵的洞。
    await invokeUpdate('codex-local', { workingDir: '/new/dir', workspaceKind: 'project' });
    await Promise.resolve();
    await Promise.resolve();

    expect(h.noteHookSessionMoved).not.toHaveBeenCalled();
  });
});

describe('local-db:sessions:move handler wiring', () => {
  it('mints the move authority and persists the new workspace target', async () => {
    const updated = (await invokeMove('codex-local', {
      kind: 'project',
      workingDir: '/new/dir',
    })) as { workingDir: string; workspaceKind: string };

    expect(h.noteHookSessionMoved).toHaveBeenCalledWith('codex-local', {
      from: '/old/dir',
      to: '/new/dir',
    });
    expect(updated.workingDir).toBe('/new/dir');
    expect(updated.workspaceKind).toBe('project');
  });

  it('registers the authority before the directory lands in the database', async () => {
    // 顺序反了就有一个"目录已变、授权还没落"的窗口,那期间到达的 IM 消息会把
    // 绑定当撤权删掉(#669 review)。用登记回调里读库来锁死这个顺序。
    h.noteHookSessionMoved.mockImplementation(async () => {
      const row = h
        .sqlite!.prepare('SELECT working_dir FROM sessions WHERE id = ?')
        .get('codex-local') as { working_dir: string | null };
      h.moveOrder.push(`db-at-note:${row.working_dir}`);
    });

    await invokeMove('codex-local', { kind: 'project', workingDir: '/new/dir' });

    expect(h.moveOrder).toEqual(['db-at-note:/old/dir']);
  });

  it('rejects callers that are not the trusted Cindy renderer', async () => {
    h.assertTrustedAppRendererEvent.mockImplementation(() => {
      throw new Error('[PERMISSION_DENIED] 此操作只能从 Cindy 主页面发起');
    });

    await expect(
      invokeMove('codex-local', { kind: 'project', workingDir: '/new/dir' }),
    ).rejects.toThrow(/PERMISSION_DENIED/);
    expect(h.noteHookSessionMoved).not.toHaveBeenCalled();
  });

  it('still moves but mints no authority when the destination is not a known project', async () => {
    h.isKnownRecentWorkdir.mockImplementation(async () => false);

    const updated = (await invokeMove('codex-local', {
      kind: 'project',
      workingDir: '/private/keys',
    })) as { workingDir: string };

    expect(h.noteHookSessionMoved).not.toHaveBeenCalled();
    expect(updated.workingDir).toBe('/private/keys');
  });

  it('does not mint authority when the move keeps the same directory', async () => {
    await invokeMove('codex-local', { kind: 'project', workingDir: '/old/dir' });

    expect(h.noteHookSessionMoved).not.toHaveBeenCalled();
  });

  it('moves back to dialogue without touching bindings', async () => {
    const updated = (await invokeMove('codex-local', { kind: 'dialogue' })) as {
      workspaceKind: string;
    };

    expect(updated.workspaceKind).toBe('dialogue');
    expect(h.noteHookSessionMoved).not.toHaveBeenCalled();
  });

  it('rejects an unknown target kind', async () => {
    await expect(invokeMove('codex-local', { kind: 'nowhere' })).rejects.toThrow(/INVALID_PARAMS/);
  });

  it('rejects a project target whose path normalizes to nothing', async () => {
    // 放过去会写成 workspaceKind='project' 且 workingDir=null 的不一致状态
    await expect(invokeMove('codex-local', { kind: 'project', workingDir: '   ' })).rejects.toThrow(
      /INVALID_PARAMS/,
    );
    expect(h.noteHookSessionMoved).not.toHaveBeenCalled();
  });
});
