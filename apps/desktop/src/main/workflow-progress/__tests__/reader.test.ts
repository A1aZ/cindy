import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  deriveWorkflowsDir,
  extractWorkflowProgress,
  readWorkflowProgressByTaskId,
} from '../reader';

// 取自 2026-07-01 实测的真实 wf_*.json 结构(裁剪)。
const REAL_RECORD = {
  runId: 'wf_fe3a6ac8-543',
  taskId: 'wmowi77vg',
  workflowName: 'parallel-news-scan',
  status: 'completed',
  agentCount: 2,
  totalTokens: 12345,
  totalToolCalls: 7,
  durationMs: 9045,
  phases: [{ title: 'Search' }],
  workflowProgress: [
    { type: 'workflow_phase', index: 1, title: 'Search' },
    {
      type: 'workflow_agent',
      index: 1,
      label: 'search:ai-tech',
      phaseIndex: 1,
      phaseTitle: 'Search',
      agentId: 'a88d563bf7405b73c',
      model: 'claude-opus-4-8[1m]',
      state: 'done',
      attempt: 1,
    },
    {
      type: 'workflow_agent',
      index: 2,
      label: 'search:finance',
      phaseIndex: 1,
      phaseTitle: 'Search',
      agentId: 'a4435b452d12607d4',
      model: 'claude-opus-4-8[1m]',
      state: 'running',
      attempt: 1,
    },
  ],
};

describe('deriveWorkflowsDir', () => {
  it('reproduces the Claude Code project-slug convention (verified against a real path)', () => {
    const dir = deriveWorkflowsDir(
      '/home/x',
      '/Users/alice/Library/Application Support/xdt-maker/dialogues/2026-07-01/7c0b5faa-d908-4a69-b4e7-0e942b9af582',
      '5b094418-10ba-4bca-b42a-f37aa0721e77',
    );
    expect(dir).toBe(
      '/home/x/.claude/projects/' +
        '-Users-alice-Library-Application-Support-xdt-maker-dialogues-2026-07-01-7c0b5faa-d908-4a69-b4e7-0e942b9af582/' +
        '5b094418-10ba-4bca-b42a-f37aa0721e77/workflows',
    );
  });
});

describe('extractWorkflowProgress', () => {
  it('parses phases and agents from a real-shaped record', () => {
    const p = extractWorkflowProgress(REAL_RECORD);
    expect(p).not.toBeNull();
    expect(p).toMatchObject({
      runId: 'wf_fe3a6ac8-543',
      workflowName: 'parallel-news-scan',
      status: 'completed',
      agentCount: 2,
      totalTokens: 12345,
      totalToolCalls: 7,
      durationMs: 9045,
    });
    expect(p!.phases).toEqual([{ index: 1, title: 'Search' }]);
    expect(p!.agents).toEqual([
      {
        label: 'search:ai-tech',
        agentId: 'a88d563bf7405b73c',
        model: 'claude-opus-4-8[1m]',
        state: 'done',
        phaseTitle: 'Search',
        attempt: 1,
      },
      {
        label: 'search:finance',
        agentId: 'a4435b452d12607d4',
        model: 'claude-opus-4-8[1m]',
        state: 'running',
        phaseTitle: 'Search',
        attempt: 1,
      },
    ]);
  });

  it('falls back to top-level phases[] when workflowProgress has no phase entries', () => {
    const p = extractWorkflowProgress({
      runId: 'wf_x',
      status: 'running',
      phases: [{ title: 'A' }, { title: 'B' }],
      workflowProgress: [],
    });
    expect(p!.phases).toEqual([
      { index: 1, title: 'A' },
      { index: 2, title: 'B' },
    ]);
    expect(p!.agents).toEqual([]);
  });

  it('skips malformed agent entries but keeps valid ones', () => {
    const p = extractWorkflowProgress({
      runId: 'wf_x',
      status: 'running',
      workflowProgress: [
        { type: 'workflow_agent', label: 'no-id' }, // 缺 agentId/state → skip
        { type: 'workflow_agent', agentId: 'a1', state: 'done' }, // label 缺 → 回退 agentId
      ],
    });
    expect(p!.agents).toEqual([{ label: 'a1', agentId: 'a1', state: 'done' }]);
  });

  it('returns null when runId is missing or input is not an object', () => {
    expect(extractWorkflowProgress({ status: 'completed' })).toBeNull();
    expect(extractWorkflowProgress(null)).toBeNull();
    expect(extractWorkflowProgress('nope')).toBeNull();
  });
});

describe('readWorkflowProgressByTaskId', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-reader-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('finds the record whose taskId matches and parses it', async () => {
    await fs.writeFile(path.join(dir, 'wf_other-111.json'), JSON.stringify({ runId: 'wf_o', taskId: 'other', workflowProgress: [] }));
    await fs.writeFile(path.join(dir, 'wf_fe3a6ac8-543.json'), JSON.stringify(REAL_RECORD));
    const p = await readWorkflowProgressByTaskId(dir, 'wmowi77vg');
    expect(p?.runId).toBe('wf_fe3a6ac8-543');
    expect(p?.agents).toHaveLength(2);
  });

  it('returns null when no file matches the taskId', async () => {
    await fs.writeFile(path.join(dir, 'wf_a.json'), JSON.stringify({ runId: 'wf_a', taskId: 'nope', workflowProgress: [] }));
    expect(await readWorkflowProgressByTaskId(dir, 'missing')).toBeNull();
  });

  it('returns null (does not throw) when the workflows dir does not exist', async () => {
    expect(await readWorkflowProgressByTaskId(path.join(dir, 'nope'), 'x')).toBeNull();
  });

  it('skips a malformed json file and still finds a valid matching one', async () => {
    await fs.writeFile(path.join(dir, 'wf_broken.json'), '{ not valid json');
    await fs.writeFile(path.join(dir, 'wf_ok.json'), JSON.stringify({ ...REAL_RECORD, runId: 'wf_ok' }));
    const p = await readWorkflowProgressByTaskId(dir, 'wmowi77vg');
    expect(p?.runId).toBe('wf_ok');
  });

  it('returns null for empty taskId', async () => {
    expect(await readWorkflowProgressByTaskId(dir, '')).toBeNull();
  });
});
