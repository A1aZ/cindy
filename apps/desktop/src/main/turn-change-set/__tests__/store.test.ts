import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const mocks = vi.hoisted(() => ({
  userDataRoot: '',
  query: vi.fn(),
  send: vi.fn(),
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
  isDataOwnerBroadcastScopeCurrent: () => true,
  tapWindowBroadcast: mocks.send,
}));

import {
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
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT id FROM sessions')) return [{ id: 'session-1' }];
      if (sql.includes('client_id IN')) return [{ clientId: 'user-1' }];
      return [];
    });
    clearPendingTurnChangeSets('session-1');
  });

  afterEach(async () => {
    clearPendingTurnChangeSets('session-1');
    await fs.rm(root, { recursive: true, force: true });
  });

  it('persists the native Codex patch under the dispatch anchor without a database write', async () => {
    beginTurnChangeSet({
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

  it('captures only the first preimage for a known-path Claude write', async () => {
    const target = path.join(workdir, 'a.ts');
    await fs.writeFile(target, 'old\n', 'utf8');
    beginTurnChangeSet({
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
    beginTurnChangeSet({
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
      path.join(mocks.userDataRoot, 'cc-agent', 'turn-change-sets', 'session-1', `${summary?.id}.json`),
      'utf8',
    );
    expect(detailRaw).not.toContain('TOKEN=');
  });

  it('labels the captured subset partial after an opaque Pi tool result', async () => {
    const target = path.join(workdir, 'a.ts');
    await fs.writeFile(target, 'old\n', 'utf8');
    beginTurnChangeSet({
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
    expect(summary).toMatchObject({ state: 'partial', incompleteReasons: ['opaque-tool'] });
  });

  it('persists a zero-file partial entry for an opaque tool with unknown targets', async () => {
    beginTurnChangeSet({
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
    });
  });

  it('does not persist remote workspace patches while remote review is unsupported', async () => {
    beginTurnChangeSet({
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
    beginTurnChangeSet({
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
      'cc-agent',
      'turn-change-sets',
      'session-1',
    );
    await fs.mkdir(sidecarDir, { recursive: true });
    const orphanPath = path.join(sidecarDir, 'orphan.json');
    await fs.writeFile(orphanPath, '{}\n', 'utf8');

    beginTurnChangeSet({
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
    beginTurnChangeSet({
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
      path.join(mocks.userDataRoot, 'cc-agent', 'turn-change-sets', 'session-1', `${summary?.id}.json`),
      'utf8',
    );
    expect(detailRaw).not.toContain('TOKEN=');
  });
});
