import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runGit } from '../../git-review/gitRunner';

const mocks = vi.hoisted(() => ({
  userDataRoot: '',
  query: vi.fn(),
  send: vi.fn(),
  ownerCurrent: true,
}));

vi.mock('electron', () => ({
  app: { getPath: () => mocks.userDataRoot },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../../localDb/client/current.js', () => ({
  getDbClient: () => ({ query: mocks.query }),
}));
vi.mock('../../device-link/broadcast-tap.js', () => ({
  captureDataOwnerBroadcastScope: () => ({ ownerStamp: undefined }),
  isDataOwnerBroadcastScopeCurrent: () => mocks.ownerCurrent,
  tapWindowBroadcast: mocks.send,
}));

import {
  TurnChangeSetActionError,
  applyTurnChangeSetAction,
  beginTurnChangeSet,
  captureKnownFileBefore,
  clearPendingTurnChangeSets,
  finalizeTurnChangeSet,
  getTurnChangeSets,
  listTurnChangeSets,
  noteOpaqueTurnChange,
  noteTurnDiffEvent,
} from '../store';

describe('turn change-set sidecar store', () => {
  let root = '';
  let workdir = '';

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-turn-change-set-'));
    workdir = path.join(root, 'workspace');
    await fs.mkdir(workdir);
    mocks.userDataRoot = path.join(root, 'user-data');
    mocks.query.mockReset();
    mocks.send.mockReset();
    mocks.ownerCurrent = true;
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('working_dir AS workingDir')) {
        return [{ workingDir: workdir, remoteHostId: null }];
      }
      if (sql.includes('SELECT id FROM sessions')) return [{ id: 'session-1' }];
      if (sql.includes('client_id IN')) return [{ clientId: 'user-1' }];
      return [];
    });
    clearPendingTurnChangeSets('session-1');
    clearPendingTurnChangeSets('session-2');
  });

  afterEach(async () => {
    clearPendingTurnChangeSets('session-1');
    clearPendingTurnChangeSets('session-2');
    await fs.rm(root, { recursive: true, force: true });
  });

  it('persists the native Codex patch under the dispatch anchor without a database write', async () => {
    await beginTurnChangeSet({
      sessionId: 'session-1',
      anchorClientId: 'user-1',
      provider: 'codex',
      cwd: workdir,
    });
    noteTurnDiffEvent('session-1', {
      type: 'turn_diff',
      source: 'codex',
      data: {
        turnId: 'turn-1',
        cwd: workdir,
        diff: [
          'diff --git a/a.ts b/a.ts',
          'index 1111111..2222222 100644',
          '--- a/a.ts',
          '+++ b/a.ts',
          '@@ -1 +1 @@',
          '-old',
          '+new',
          '',
        ].join('\n'),
      },
    });
    finalizeTurnChangeSet('session-1', 'turn-1', 'complete');

    await vi.waitFor(async () => expect(await listTurnChangeSets('session-1')).toHaveLength(1));
    const [summary] = await listTurnChangeSets('session-1');
    expect(summary).toMatchObject({
      anchorClientId: 'user-1',
      provider: 'codex',
      providerTurnId: 'turn-1',
      state: 'complete',
      additions: 1,
      deletions: 1,
    });
  });

  it('undoes and reapplies an exact text patch without changing chat history', async () => {
    const target = path.join(workdir, 'a.ts');
    await fs.writeFile(target, 'new\n', 'utf8');
    await beginTurnChangeSet({
      sessionId: 'session-1',
      anchorClientId: 'user-1',
      provider: 'codex',
      cwd: workdir,
    });
    noteTurnDiffEvent('session-1', {
      type: 'turn_diff',
      source: 'codex',
      data: {
        turnId: 'turn-action',
        cwd: workdir,
        diff: [
          'diff --git a/a.ts b/a.ts',
          '--- a/a.ts',
          '+++ b/a.ts',
          '@@ -1 +1 @@',
          '-old',
          '+new',
          '',
        ].join('\n'),
      },
    });
    await finalizeTurnChangeSet('session-1', 'turn-action', 'complete');
    const [recorded] = await listTurnChangeSets('session-1');

    const undo = await applyTurnChangeSetAction('session-1', recorded!.id, 'undo');
    expect(await fs.readFile(target, 'utf8')).toBe('old\n');
    expect(undo).toMatchObject({ action: 'undo', changed: true });
    expect(undo.summary.workspaceState).toBe('undone');
    expect((await listTurnChangeSets('session-1'))[0]?.workspaceState).toBe('undone');

    const reapply = await applyTurnChangeSetAction('session-1', recorded!.id, 'reapply');
    expect(await fs.readFile(target, 'utf8')).toBe('new\n');
    expect(reapply.summary.workspaceState).toBe('applied');
  });

  it('reports a missing Git executable without changing the workspace', async () => {
    const target = path.join(workdir, 'missing-git.ts');
    await fs.writeFile(target, 'new\n', 'utf8');
    await beginTurnChangeSet({
      sessionId: 'session-1',
      anchorClientId: 'user-1',
      provider: 'codex',
      cwd: workdir,
    });
    noteTurnDiffEvent('session-1', {
      type: 'turn_diff',
      source: 'codex',
      data: {
        turnId: 'turn-missing-git',
        cwd: workdir,
        diff: [
          'diff --git a/missing-git.ts b/missing-git.ts',
          '--- a/missing-git.ts',
          '+++ b/missing-git.ts',
          '@@ -1 +1 @@',
          '-old',
          '+new',
          '',
        ].join('\n'),
      },
    });
    await finalizeTurnChangeSet('session-1', 'turn-missing-git', 'complete');
    const [recorded] = await listTurnChangeSets('session-1');
    const originalPath = process.env.PATH;

    try {
      process.env.PATH = root;
      await expect(applyTurnChangeSetAction('session-1', recorded!.id, 'undo'))
        .rejects.toMatchObject({ kind: 'git-missing' } satisfies Partial<TurnChangeSetActionError>);
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }

    expect(await fs.readFile(target, 'utf8')).toBe('new\n');
    expect((await listTurnChangeSets('session-1'))[0]?.workspaceState).toBe('applied');
  });

  it('keeps every file unchanged when one hunk conflicts', async () => {
    const first = path.join(workdir, 'a.ts');
    const second = path.join(workdir, 'b.ts');
    await fs.writeFile(first, 'new-a\n', 'utf8');
    await fs.writeFile(second, 'new-b\n', 'utf8');
    await beginTurnChangeSet({
      sessionId: 'session-1',
      anchorClientId: 'user-1',
      provider: 'codex',
      cwd: workdir,
    });
    noteTurnDiffEvent('session-1', {
      type: 'turn_diff',
      source: 'codex',
      data: {
        turnId: 'turn-conflict',
        cwd: workdir,
        diff: [
          'diff --git a/a.ts b/a.ts',
          '--- a/a.ts',
          '+++ b/a.ts',
          '@@ -1 +1 @@',
          '-old-a',
          '+new-a',
          'diff --git a/b.ts b/b.ts',
          '--- a/b.ts',
          '+++ b/b.ts',
          '@@ -1 +1 @@',
          '-old-b',
          '+new-b',
          '',
        ].join('\n'),
      },
    });
    await finalizeTurnChangeSet('session-1', 'turn-conflict', 'complete');
    const [recorded] = await listTurnChangeSets('session-1');
    await fs.writeFile(second, 'user-edit\n', 'utf8');

    await expect(applyTurnChangeSetAction('session-1', recorded!.id, 'undo'))
      .rejects.toMatchObject({ kind: 'conflict' } satisfies Partial<TurnChangeSetActionError>);
    expect(await fs.readFile(first, 'utf8')).toBe('new-a\n');
    expect(await fs.readFile(second, 'utf8')).toBe('user-edit\n');
    expect((await listTurnChangeSets('session-1'))[0]?.workspaceState).toBe('applied');
  });

  it('undoes and reapplies a newly created file for Claude without a Git repository', async () => {
    const target = path.join(workdir, 'created.txt');
    await beginTurnChangeSet({
      sessionId: 'session-1',
      anchorClientId: 'user-1',
      provider: 'claude-code',
      cwd: workdir,
    });
    await captureKnownFileBefore({
      sessionId: 'session-1',
      provider: 'claude-code',
      cwd: workdir,
      targetPath: 'created.txt',
    });
    await fs.writeFile(target, 'created\n', 'utf8');
    await finalizeTurnChangeSet('session-1', null, 'complete');
    const [recorded] = await listTurnChangeSets('session-1');

    await applyTurnChangeSetAction('session-1', recorded!.id, 'undo');
    await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' });

    await applyTurnChangeSetAction('session-1', recorded!.id, 'reapply');
    expect(await fs.readFile(target, 'utf8')).toBe('created\n');
  });

  it('undoes and reapplies a deleted file for Pi without a Git repository', async () => {
    const target = path.join(workdir, 'deleted.txt');
    await fs.writeFile(target, 'before deletion\n', 'utf8');
    await beginTurnChangeSet({
      sessionId: 'session-1',
      anchorClientId: 'user-1',
      provider: 'pi',
      cwd: workdir,
    });
    await captureKnownFileBefore({
      sessionId: 'session-1',
      provider: 'pi',
      cwd: workdir,
      targetPath: 'deleted.txt',
    });
    await fs.rm(target);
    await finalizeTurnChangeSet('session-1', null, 'complete');
    const [recorded] = await listTurnChangeSets('session-1');

    await applyTurnChangeSetAction('session-1', recorded!.id, 'undo');
    expect(await fs.readFile(target, 'utf8')).toBe('before deletion\n');

    await applyTurnChangeSetAction('session-1', recorded!.id, 'reapply');
    await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves a UTF-8 BOM byte-for-byte through Claude undo and reapply', async () => {
    const target = path.join(workdir, 'bom.txt');
    const before = Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from('old\n')]);
    const after = Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from('new\n')]);
    await fs.writeFile(target, before);
    await beginTurnChangeSet({
      sessionId: 'session-1',
      anchorClientId: 'user-1',
      provider: 'claude-code',
      cwd: workdir,
    });
    await captureKnownFileBefore({
      sessionId: 'session-1',
      provider: 'claude-code',
      cwd: workdir,
      targetPath: 'bom.txt',
    });
    await fs.writeFile(target, after);
    await finalizeTurnChangeSet('session-1', null, 'complete');
    const [recorded] = await listTurnChangeSets('session-1');

    await applyTurnChangeSetAction('session-1', recorded!.id, 'undo');
    expect(await fs.readFile(target)).toEqual(before);
    await applyTurnChangeSetAction('session-1', recorded!.id, 'reapply');
    expect(await fs.readFile(target)).toEqual(after);
  });

  it('keeps legacy sidecar patches review-only', async () => {
    const target = path.join(workdir, 'legacy.txt');
    await fs.writeFile(target, 'new\n', 'utf8');
    await beginTurnChangeSet({
      sessionId: 'session-1',
      anchorClientId: 'user-1',
      provider: 'codex',
      cwd: workdir,
    });
    noteTurnDiffEvent('session-1', {
      type: 'turn_diff',
      source: 'codex',
      data: {
        turnId: 'turn-legacy',
        cwd: workdir,
        diff: [
          'diff --git a/legacy.txt b/legacy.txt',
          '--- a/legacy.txt',
          '+++ b/legacy.txt',
          '@@ -1 +1 @@',
          '-old',
          '+new',
          '',
        ].join('\n'),
      },
    });
    await finalizeTurnChangeSet('session-1', 'turn-legacy', 'complete');
    const sidecarDir = path.join(mocks.userDataRoot, 'turn-change-sets', 'session-1');
    const indexPath = path.join(sidecarDir, 'index.json');
    const index = JSON.parse(await fs.readFile(indexPath, 'utf8')) as {
      version: number;
      entries: Array<{ id: string }>;
    };
    index.version = 1;
    await fs.writeFile(indexPath, `${JSON.stringify(index)}\n`, 'utf8');
    const detailPath = path.join(sidecarDir, `${index.entries[0]!.id}.json`);
    const detail = JSON.parse(await fs.readFile(detailPath, 'utf8')) as {
      reversibleFormat?: string;
    };
    delete detail.reversibleFormat;
    await fs.writeFile(detailPath, `${JSON.stringify(detail)}\n`, 'utf8');

    expect((await listTurnChangeSets('session-1'))[0]?.isReversible).toBe(false);
    await expect(applyTurnChangeSetAction('session-1', index.entries[0]!.id, 'undo'))
      .rejects.toMatchObject({ kind: 'unsupported' } satisfies Partial<TurnChangeSetActionError>);
    expect(await fs.readFile(target, 'utf8')).toBe('new\n');
  });

  it('rejects undo while another task is changing the same workspace', async () => {
    const target = path.join(workdir, 'busy.txt');
    await fs.writeFile(target, 'new\n', 'utf8');
    await beginTurnChangeSet({
      sessionId: 'session-1',
      anchorClientId: 'user-1',
      provider: 'codex',
      cwd: workdir,
    });
    noteTurnDiffEvent('session-1', {
      type: 'turn_diff',
      source: 'codex',
      data: {
        turnId: 'turn-busy',
        cwd: workdir,
        diff: [
          'diff --git a/busy.txt b/busy.txt',
          '--- a/busy.txt',
          '+++ b/busy.txt',
          '@@ -1 +1 @@',
          '-old',
          '+new',
          '',
        ].join('\n'),
      },
    });
    await finalizeTurnChangeSet('session-1', 'turn-busy', 'complete');
    const [recorded] = await listTurnChangeSets('session-1');
    await beginTurnChangeSet({
      sessionId: 'session-2',
      anchorClientId: 'user-2',
      provider: 'pi',
      cwd: workdir,
    });

    await expect(applyTurnChangeSetAction('session-1', recorded!.id, 'undo'))
      .rejects.toMatchObject({ kind: 'busy' } satisfies Partial<TurnChangeSetActionError>);
    expect(await fs.readFile(target, 'utf8')).toBe('new\n');
    clearPendingTurnChangeSets('session-2');
  });

  it('fails closed before mutation when the data-owner scope is stale', async () => {
    const target = path.join(workdir, 'owner.txt');
    await fs.writeFile(target, 'new\n', 'utf8');
    await beginTurnChangeSet({
      sessionId: 'session-1',
      anchorClientId: 'user-1',
      provider: 'codex',
      cwd: workdir,
    });
    noteTurnDiffEvent('session-1', {
      type: 'turn_diff',
      source: 'codex',
      data: {
        turnId: 'turn-owner',
        cwd: workdir,
        diff: [
          'diff --git a/owner.txt b/owner.txt',
          '--- a/owner.txt',
          '+++ b/owner.txt',
          '@@ -1 +1 @@',
          '-old',
          '+new',
          '',
        ].join('\n'),
      },
    });
    await finalizeTurnChangeSet('session-1', 'turn-owner', 'complete');
    const [recorded] = await listTurnChangeSets('session-1');
    mocks.ownerCurrent = false;

    await expect(applyTurnChangeSetAction('session-1', recorded!.id, 'undo'))
      .rejects.toMatchObject({ kind: 'busy' } satisfies Partial<TurnChangeSetActionError>);
    expect(await fs.readFile(target, 'utf8')).toBe('new\n');
    mocks.ownerCurrent = true;
    expect((await listTurnChangeSets('session-1'))[0]?.workspaceState).toBe('applied');
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('reverses and reapplies a pure Codex rename through Git apply', async () => {
    await runGit(['init', '-q'], { cwd: workdir });
    const oldTarget = path.join(workdir, 'old.txt');
    const newTarget = path.join(workdir, 'new.txt');
    await fs.writeFile(oldTarget, 'same\n', 'utf8');
    await runGit(['add', 'old.txt'], { cwd: workdir });
    await fs.rename(oldTarget, newTarget);
    await beginTurnChangeSet({
      sessionId: 'session-1',
      anchorClientId: 'user-1',
      provider: 'codex',
      cwd: workdir,
    });
    noteTurnDiffEvent('session-1', {
      type: 'turn_diff',
      source: 'codex',
      data: {
        turnId: 'turn-rename',
        cwd: workdir,
        diff: [
          'diff --git a/old.txt b/new.txt',
          'similarity index 100%',
          'rename from old.txt',
          'rename to new.txt',
          '',
        ].join('\n'),
      },
    });
    await finalizeTurnChangeSet('session-1', 'turn-rename', 'complete');
    const [recorded] = await listTurnChangeSets('session-1');
    expect(recorded?.isReversible).toBe(true);

    await applyTurnChangeSetAction('session-1', recorded!.id, 'undo');
    expect(await fs.readFile(oldTarget, 'utf8')).toBe('same\n');
    await expect(fs.stat(newTarget)).rejects.toMatchObject({ code: 'ENOENT' });

    await applyTurnChangeSetAction('session-1', recorded!.id, 'reapply');
    expect(await fs.readFile(newTarget, 'utf8')).toBe('same\n');
    await expect(fs.stat(oldTarget)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not advertise a binary-only native patch as reversible', async () => {
    await beginTurnChangeSet({
      sessionId: 'session-1',
      anchorClientId: 'user-1',
      provider: 'codex',
      cwd: workdir,
    });
    noteTurnDiffEvent('session-1', {
      type: 'turn_diff',
      source: 'codex',
      data: {
        turnId: 'turn-binary',
        cwd: workdir,
        diff: [
          'diff --git a/image.png b/image.png',
          'index 1111111..2222222 100644',
          'Binary files a/image.png and b/image.png differ',
          '',
        ].join('\n'),
      },
    });
    await finalizeTurnChangeSet('session-1', 'turn-binary', 'complete');

    const [recorded] = await listTurnChangeSets('session-1');
    expect(recorded).toMatchObject({ isReversible: false });
  });

  it('captures only the first preimage for a known-path Claude write', async () => {
    const target = path.join(workdir, 'a.ts');
    await fs.writeFile(target, 'old\n', 'utf8');
    await beginTurnChangeSet({
      sessionId: 'session-1',
      anchorClientId: 'user-1',
      provider: 'claude-code',
      cwd: workdir,
    });
    await captureKnownFileBefore({
      sessionId: 'session-1',
      provider: 'claude-code',
      cwd: workdir,
      targetPath: 'a.ts',
    });
    await fs.writeFile(target, 'middle\n', 'utf8');
    await captureKnownFileBefore({
      sessionId: 'session-1',
      provider: 'claude-code',
      cwd: workdir,
      targetPath: 'a.ts',
    });
    await fs.writeFile(target, 'new\n', 'utf8');
    finalizeTurnChangeSet('session-1', null, 'complete');

    await vi.waitFor(async () => expect(await listTurnChangeSets('session-1')).toHaveLength(1));
    const [summary] = await listTurnChangeSets('session-1');
    expect(summary).toMatchObject({ provider: 'claude-code', state: 'complete' });
    expect(summary?.files[0]).toMatchObject({ path: 'a.ts', additions: 1, deletions: 1 });
  });

  it('filters sensitive files from a native Codex patch', async () => {
    await beginTurnChangeSet({
      sessionId: 'session-1',
      anchorClientId: 'user-1',
      provider: 'codex',
      cwd: workdir,
    });
    noteTurnDiffEvent('session-1', {
      type: 'turn_diff',
      source: 'codex',
      data: {
        turnId: 'turn-1',
        cwd: workdir,
        diff: [
          'diff --git a/a.ts b/a.ts',
          '--- a/a.ts',
          '+++ b/a.ts',
          '@@ -1 +1 @@',
          '-old',
          '+new',
          'diff --git a/.env b/.env',
          '--- a/.env',
          '+++ b/.env',
          '@@ -1 +1 @@',
          '-TOKEN=old',
          '+TOKEN=new',
          '',
        ].join('\n'),
      },
    });
    finalizeTurnChangeSet('session-1', 'turn-1', 'complete');

    await vi.waitFor(async () => expect(await listTurnChangeSets('session-1')).toHaveLength(1));
    const [summary] = await listTurnChangeSets('session-1');
    expect(summary).toMatchObject({ state: 'partial', incompleteReasons: ['sensitive-file'] });
    expect(summary?.files.map((file) => file.path)).toEqual(['a.ts']);
    const detailRaw = await fs.readFile(
      path.join(mocks.userDataRoot, 'turn-change-sets', 'session-1', `${summary?.id}.json`),
      'utf8',
    );
    expect(detailRaw).not.toContain('TOKEN=');
  });

  it('labels the captured subset partial after an opaque Pi tool result', async () => {
    const target = path.join(workdir, 'a.ts');
    await fs.writeFile(target, 'old\n', 'utf8');
    await beginTurnChangeSet({
      sessionId: 'session-1',
      anchorClientId: 'user-1',
      provider: 'pi',
      cwd: workdir,
    });
    await captureKnownFileBefore({
      sessionId: 'session-1',
      provider: 'pi',
      cwd: workdir,
      targetPath: target,
    });
    await fs.writeFile(target, 'new\n', 'utf8');
    noteOpaqueTurnChange({ sessionId: 'session-1', provider: 'pi', cwd: workdir });
    finalizeTurnChangeSet('session-1', null, 'complete');

    await vi.waitFor(async () => expect(await listTurnChangeSets('session-1')).toHaveLength(1));
    const [summary] = await listTurnChangeSets('session-1');
    expect(summary).toMatchObject({
      state: 'partial',
      incompleteReasons: ['opaque-tool'],
      isReversible: true,
    });

    await applyTurnChangeSetAction('session-1', summary!.id, 'undo');
    expect(await fs.readFile(target, 'utf8')).toBe('old\n');
    await applyTurnChangeSetAction('session-1', summary!.id, 'reapply');
    expect(await fs.readFile(target, 'utf8')).toBe('new\n');
  });

  it('reads a v2 partial index with the exact captured-subset capability', async () => {
    const target = path.join(workdir, 'legacy-partial.ts');
    await fs.writeFile(target, 'old\n', 'utf8');
    await beginTurnChangeSet({
      sessionId: 'session-1',
      anchorClientId: 'user-1',
      provider: 'claude-code',
      cwd: workdir,
    });
    await captureKnownFileBefore({
      sessionId: 'session-1',
      provider: 'claude-code',
      cwd: workdir,
      targetPath: target,
    });
    await fs.writeFile(target, 'new\n', 'utf8');
    noteOpaqueTurnChange({ sessionId: 'session-1', provider: 'claude-code', cwd: workdir });
    await finalizeTurnChangeSet('session-1', null, 'complete');

    await vi.waitFor(async () => expect(await listTurnChangeSets('session-1')).toHaveLength(1));
    const indexPath = path.join(
      mocks.userDataRoot,
      'turn-change-sets',
      'session-1',
      'index.json',
    );
    const index = JSON.parse(await fs.readFile(indexPath, 'utf8')) as {
      version: number;
      entries: Array<{ isReversible: boolean }>;
    };
    index.version = 2;
    index.entries[0]!.isReversible = false;
    await fs.writeFile(indexPath, `${JSON.stringify(index)}\n`, 'utf8');

    const [legacySummary] = await listTurnChangeSets('session-1');
    expect(legacySummary?.isReversible).toBe(true);
    expect(JSON.parse(await fs.readFile(indexPath, 'utf8'))).toMatchObject({ version: 2 });

    const nextTarget = path.join(workdir, 'next.ts');
    await fs.writeFile(nextTarget, 'before\n', 'utf8');
    await beginTurnChangeSet({
      sessionId: 'session-1',
      anchorClientId: 'user-1',
      provider: 'claude-code',
      cwd: workdir,
    });
    await captureKnownFileBefore({
      sessionId: 'session-1',
      provider: 'claude-code',
      cwd: workdir,
      targetPath: nextTarget,
    });
    await fs.writeFile(nextTarget, 'after\n', 'utf8');
    await finalizeTurnChangeSet('session-1', null, 'complete');
    expect(await listTurnChangeSets('session-1')).toHaveLength(2);

    const upgradedIndex = JSON.parse(await fs.readFile(indexPath, 'utf8')) as {
      version: number;
      entries: Array<{ id: string; isReversible: boolean }>;
    };
    expect(upgradedIndex.version).toBe(3);
    expect(upgradedIndex.entries.find((entry) => entry.id === legacySummary!.id))
      .toMatchObject({ isReversible: true });
  });

  it('persists a zero-file partial entry for an opaque tool with unknown targets', async () => {
    await beginTurnChangeSet({
      sessionId: 'session-1',
      anchorClientId: 'user-1',
      provider: 'pi',
      cwd: workdir,
    });
    noteOpaqueTurnChange({ sessionId: 'session-1', provider: 'pi', cwd: workdir });
    await finalizeTurnChangeSet('session-1', null, 'complete');

    const [summary] = await listTurnChangeSets('session-1');
    expect(summary).toMatchObject({
      state: 'partial',
      incompleteReasons: ['opaque-tool'],
      fileCount: 0,
      files: [],
      isReversible: false,
    });
  });

  it('does not persist remote workspace patches while remote review is unsupported', async () => {
    await beginTurnChangeSet({
      sessionId: 'session-1',
      anchorClientId: 'user-1',
      provider: 'codex',
      cwd: workdir,
      remote: true,
    });
    noteTurnDiffEvent('session-1', {
      type: 'turn_diff',
      source: 'codex',
      data: {
        turnId: 'turn-remote',
        cwd: workdir,
        diff: [
          'diff --git a/a.ts b/a.ts',
          '--- a/a.ts',
          '+++ b/a.ts',
          '@@ -1 +1 @@',
          '-old',
          '+new',
          '',
        ].join('\n'),
      },
    });
    await finalizeTurnChangeSet('session-1', 'turn-remote', 'complete');

    expect(await listTurnChangeSets('session-1')).toEqual([]);
  });

  it('bounds the card index while preserving the complete patch for exact review', async () => {
    await beginTurnChangeSet({
      sessionId: 'session-1',
      anchorClientId: 'user-1',
      provider: 'codex',
      cwd: workdir,
    });
    const diff = Array.from({ length: 55 }, (_, index) => [
      `diff --git a/file-${index}.ts b/file-${index}.ts`,
      `--- a/file-${index}.ts`,
      `+++ b/file-${index}.ts`,
      '@@ -1 +1 @@',
      '-old',
      '+new',
      '',
    ].join('\n')).join('');
    noteTurnDiffEvent('session-1', {
      type: 'turn_diff',
      source: 'codex',
      data: { turnId: 'turn-many-files', cwd: workdir, diff },
    });
    await finalizeTurnChangeSet('session-1', 'turn-many-files', 'complete');

    const [summary] = await listTurnChangeSets('session-1');
    expect(summary).toMatchObject({ state: 'complete', fileCount: 55 });
    expect(summary?.files).toHaveLength(50);
    const [detail] = await getTurnChangeSets('session-1', [summary!.id]);
    expect(detail?.diffs).toHaveLength(55);
  });

  it('removes orphan detail files after the next successful index publish', async () => {
    const sidecarDir = path.join(
      mocks.userDataRoot,
      'turn-change-sets',
      'session-1',
    );
    await fs.mkdir(sidecarDir, { recursive: true });
    const orphanPath = path.join(sidecarDir, 'orphan.json');
    await fs.writeFile(orphanPath, '{}\n', 'utf8');

    await beginTurnChangeSet({
      sessionId: 'session-1',
      anchorClientId: 'user-1',
      provider: 'pi',
      cwd: workdir,
    });
    noteOpaqueTurnChange({ sessionId: 'session-1', provider: 'pi', cwd: workdir });
    await finalizeTurnChangeSet('session-1', null, 'complete');

    await expect(fs.stat(orphanPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await listTurnChangeSets('session-1')).toHaveLength(1);
  });

  it('never persists sensitive file contents in a captured subset', async () => {
    const safeTarget = path.join(workdir, 'a.ts');
    const secretTarget = path.join(workdir, '.env');
    await fs.writeFile(safeTarget, 'old\n', 'utf8');
    await fs.writeFile(secretTarget, 'TOKEN=old\n', 'utf8');
    await beginTurnChangeSet({
      sessionId: 'session-1',
      anchorClientId: 'user-1',
      provider: 'claude-code',
      cwd: workdir,
    });
    await captureKnownFileBefore({
      sessionId: 'session-1',
      provider: 'claude-code',
      cwd: workdir,
      targetPath: 'a.ts',
    });
    await captureKnownFileBefore({
      sessionId: 'session-1',
      provider: 'claude-code',
      cwd: workdir,
      targetPath: '.env',
    });
    await fs.writeFile(safeTarget, 'new\n', 'utf8');
    await fs.writeFile(secretTarget, 'TOKEN=new\n', 'utf8');
    finalizeTurnChangeSet('session-1', null, 'complete');

    await vi.waitFor(async () => expect(await listTurnChangeSets('session-1')).toHaveLength(1));
    const [summary] = await listTurnChangeSets('session-1');
    expect(summary).toMatchObject({ state: 'partial', incompleteReasons: ['sensitive-file'] });
    expect(summary?.files.map((file) => file.path)).toEqual(['a.ts']);
    const detailRaw = await fs.readFile(
      path.join(mocks.userDataRoot, 'turn-change-sets', 'session-1', `${summary?.id}.json`),
      'utf8',
    );
    expect(detailRaw).not.toContain('TOKEN=');
  });
});
