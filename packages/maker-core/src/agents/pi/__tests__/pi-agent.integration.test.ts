/**
 * PiAgent 端到端集成测试 —— 真 spawn pi 二进制 + 本地假 Anthropic 网关。
 *
 * 覆盖链路:startSession(spawn pi --mode rpc + models.json 生成)→ session_id
 * 回填 → send(prompt)→ 假网关 SSE 流 → translator(text/status/done 事件)→
 * usage 快照 → close。
 *
 * 依赖 apps/pi-bin/<platform>/pi 就位(pnpm install:pi);二进制缺失时整组 skip
 * (CI / 未装 pi 的环境不红)。
 */

import { createServer, type Server } from 'node:http';
import { mkdtempSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PiAgent } from '../index.js';
import type { AgentDeps, AgentSessionHandle } from '../../base-agent.js';
import type { AgentEvent } from '../../../types/events.js';
import type { Logger } from '../../../interfaces/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../../../../..');
const PI_BINARY = path.join(
  REPO_ROOT,
  'apps',
  'pi-bin',
  `${process.platform}-${process.arch}`,
  process.platform === 'win32' ? 'pi.exe' : 'pi',
);

const piAvailable = existsSync(PI_BINARY);

const noopLogger: Logger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  child: () => noopLogger,
};

function sse(events: Array<{ event: string; data: unknown }>): string {
  return events
    .map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join('');
}

/** 最小合法的 Anthropic Messages SSE 流:一段 text + usage。 */
function anthropicStreamBody(text: string): string {
  return sse([
    {
      event: 'message_start',
      data: {
        type: 'message_start',
        message: {
          id: 'msg_test_1',
          type: 'message',
          role: 'assistant',
          model: 'pi-test-model',
          content: [],
          stop_reason: null,
          usage: { input_tokens: 42, output_tokens: 0 },
        },
      },
    },
    { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    {
      event: 'message_delta',
      data: { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 7 } },
    },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ]);
}

describe.skipIf(!piAvailable)('PiAgent integration (real pi binary + fake gateway)', () => {
  let server: Server;
  let endpoint = '';
  let agentHome = '';
  const seenRequests: Array<{
    url: string;
    auth: string | undefined;
    sessionId: string | undefined;
    body: string;
  }> = [];

  beforeAll(async () => {
    agentHome = mkdtempSync(path.join(tmpdir(), 'pi-agent-int-'));
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        seenRequests.push({
          url: req.url ?? '',
          auth: (req.headers['x-api-key'] as string | undefined) ?? (req.headers.authorization as string | undefined),
          sessionId: req.headers['x-cindy-pi-session-id'] as string | undefined,
          body,
        });
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
        });
        res.end(anthropicStreamBody('pong from fake gateway'));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (typeof address === 'object' && address) endpoint = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(agentHome, { recursive: true, force: true });
  });

  function buildDeps(): AgentDeps {
    return {
      auth: {
        getState: async () => ({ authenticated: true, identity: 'test', authSource: 'api-key' as const }),
        triggerLogin: async () => ({ authenticated: true }),
        logout: async () => {},
        getAuthEnv: async () => ({ CINDY_PI_API_KEY: 'test-key-123' }),
      },
      runtimeConfig: { endpoint },
      binaryPath: PI_BINARY,
      logger: noopLogger,
      capabilityAdditions: {
        availableModels: [
          {
            id: 'pi-test-model',
            displayName: 'Pi Test Model',
            contextWindow: 200_000,
            efforts: [],
            defaultEffort: null,
          },
        ],
      },
      resolvePiAgentHome: () => agentHome,
    };
  }

  it(
    'startSession → send → streams text and settles → usage/cost tracked → close',
    { timeout: 60_000 },
    async () => {
      const agent = new PiAgent(buildDeps());
      const workingDir = mkdtempSync(path.join(tmpdir(), 'pi-agent-cwd-'));
      let handle: AgentSessionHandle | null = null;
      try {
        handle = await agent.startSession({
          sessionId: 'itest-session',
          workingDir,
          model: 'pi-test-model',
        });

        expect(handle.agentKind).toBe('pi');
        // sdkSessionId = pi 会话 JSONL 路径(resume 钥匙)
        expect(handle.id.length).toBeGreaterThan(0);

        const events: AgentEvent[] = [];
        const collected = (async () => {
          for await (const ev of handle!.events()) {
            events.push(ev);
            if (ev.type === 'done') break;
          }
        })();

        await handle.send({ type: 'user', content: 'ping' });
        await collected;

        const types = events.map((e) => e.type);
        expect(types).toContain('session_id');
        expect(types).toContain('text');
        expect(types).toContain('done');

        const finalText = events
          .filter((e) => e.type === 'text')
          .map((e) => (e.data as { text: string; isFinal?: boolean }))
          .filter((d) => d.isFinal)
          .map((d) => d.text)
          .join('');
        expect(finalText).toContain('pong from fake gateway');

        // 请求真的打到了假网关,且带上了 env 插值出来的 key
        expect(seenRequests.length).toBeGreaterThan(0);
        expect(seenRequests.some((r) => (r.auth ?? '').includes('test-key-123'))).toBe(true);
        expect(seenRequests.some((r) => r.sessionId === 'itest-session')).toBe(true);

        // usage:input 42 + output 7(anthropic 流里的 usage 记账)
        const usage = handle.getUsageSnapshot();
        expect(usage.tokenUsage).toBeGreaterThan(0);
      } finally {
        await handle?.close();
        rmSync(workingDir, { recursive: true, force: true });
      }
    },
  );

  it(
    'forkSdkSession clones a live session into a new session file (offline, no gateway)',
    { timeout: 60_000 },
    async () => {
      const agent = new PiAgent(buildDeps());
      const workingDir = mkdtempSync(path.join(tmpdir(), 'pi-fork-cwd-'));
      let handle: AgentSessionHandle | null = null;
      try {
        handle = await agent.startSession({
          sessionId: 'fork-src-session',
          workingDir,
          model: 'pi-test-model',
        });
        // 跑一轮让源 session 落盘内容(fork 读的是持久化的 jsonl)。
        const done = (async () => {
          for await (const ev of handle!.events()) {
            if (ev.type === 'done') break;
          }
        })();
        await handle.send({ type: 'user', content: 'seed message for fork' });
        await done;

        const sourceId = handle.id;
        expect(sourceId.length).toBeGreaterThan(0);

        // 整条 fork(tailTurnsToDrop 省略 = 0 → clone)。fork 进程 --offline,不打网关。
        const seenBefore = seenRequests.length;
        const forked = await agent.forkSdkSession({
          sourceSdkSessionId: sourceId,
          upToMessageId: undefined,
          title: 'forked branch',
        });

        expect(forked.newSdkSessionId.length).toBeGreaterThan(0);
        expect(forked.newSdkSessionId).not.toBe(sourceId);
        expect(existsSync(forked.newSdkSessionId)).toBe(true);
        // 与 Codex 一致:pi 不落 SDK message uuid,uuidMap 为空。
        expect(forked.uuidMap.size).toBe(0);
        // fork 是纯本地文件操作,不应产生任何网关请求。
        expect(seenRequests.length).toBe(seenBefore);
      } finally {
        await handle?.close();
        rmSync(workingDir, { recursive: true, force: true });
      }
    },
  );

  it(
    'forwards an image attachment through pi to the gateway (multimodal image)',
    { timeout: 60_000 },
    async () => {
      // 合法 1x1 透明 PNG —— pi 不会因非法图片拒收;其 base64 应原样出现在网关请求体。
      const PNG_1x1_B64 =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
      const agent = new PiAgent(buildDeps());
      const workingDir = mkdtempSync(path.join(tmpdir(), 'pi-img-cwd-'));
      let handle: AgentSessionHandle | null = null;
      try {
        const imgPath = path.join(workingDir, 'pixel.png');
        writeFileSync(imgPath, Buffer.from(PNG_1x1_B64, 'base64'));

        handle = await agent.startSession({
          sessionId: 'img-session',
          workingDir,
          model: 'pi-test-model',
        });
        const done = (async () => {
          for await (const ev of handle!.events()) {
            if (ev.type === 'done') break;
          }
        })();
        await handle.send({
          type: 'user',
          content: [
            { type: 'text', text: 'what is in this image?' },
            { type: 'image', path: imgPath },
          ],
        });
        await done;

        // pi 应把图片 base64 转发进网关请求(Anthropic image content block)。
        const sawImage = seenRequests.some((r) => r.body.includes(PNG_1x1_B64));
        expect(sawImage).toBe(true);
      } finally {
        await handle?.close();
        rmSync(workingDir, { recursive: true, force: true });
      }
    },
  );

  it(
    'setPlanMode toggles plan mode via the bundled plan-mode extension (/plan, no gateway)',
    { timeout: 60_000 },
    async () => {
      const agent = new PiAgent(buildDeps());
      const workingDir = mkdtempSync(path.join(tmpdir(), 'pi-plan-cwd-'));
      let handle: AgentSessionHandle | null = null;
      try {
        handle = await agent.startSession({
          sessionId: 'plan-mode-session',
          workingDir,
          model: 'pi-test-model',
        });
        // 初始关闭。
        expect(handle.getPlanMode?.()).toBe(false);

        const seenBefore = seenRequests.length;
        // 开启:/plan 是扩展命令,即时执行,不调模型 → 无网关请求。
        await handle.setPlanMode?.(true);
        expect(handle.getPlanMode?.()).toBe(true);

        // 幂等:重复开启不再 toggle。
        await handle.setPlanMode?.(true);
        expect(handle.getPlanMode?.()).toBe(true);

        // 关闭恢复。
        await handle.setPlanMode?.(false);
        expect(handle.getPlanMode?.()).toBe(false);

        expect(seenRequests.length).toBe(seenBefore);
      } finally {
        await handle?.close();
        rmSync(workingDir, { recursive: true, force: true });
      }
    },
  );

  it(
    're-syncs plan mode from pi persisted state on resume (no mirror desync)',
    { timeout: 60_000 },
    async () => {
      const agent = new PiAgent(buildDeps());
      const workingDir = mkdtempSync(path.join(tmpdir(), 'pi-plan-resume-cwd-'));
      let handle: AgentSessionHandle | null = null;
      let resumed: AgentSessionHandle | null = null;
      try {
        handle = await agent.startSession({
          sessionId: 'plan-resume-session',
          workingDir,
          model: 'pi-test-model',
        });
        // 先跑一轮真实 turn 让会话落盘(pi 对纯扩展活动的会话可能不持久化)。
        const done = (async () => {
          for await (const ev of handle!.events()) {
            if (ev.type === 'done') break;
          }
        })();
        await handle.send({ type: 'user', content: 'seed message so the session persists' });
        await done;

        await handle.setPlanMode?.(true);
        expect(handle.getPlanMode?.()).toBe(true);
        const resumeKey = handle.id; // pi 会话文件路径 = resume 钥匙
        await handle.close();
        handle = null;

        // resume 同一会话:pi 的 plan-mode 扩展自恢复 planModeEnabled=true,新会话的
        // planModeActive 必须从 get_entries 校正回 true(而非默认 false),否则 /plan toggle 会锁死。
        resumed = await agent.startSession({
          sessionId: 'plan-resume-session-2',
          workingDir,
          model: 'pi-test-model',
          resumeSessionId: resumeKey,
        });
        expect(resumed.getPlanMode?.()).toBe(true);
      } finally {
        await handle?.close();
        await resumed?.close();
        rmSync(workingDir, { recursive: true, force: true });
      }
    },
  );
});
