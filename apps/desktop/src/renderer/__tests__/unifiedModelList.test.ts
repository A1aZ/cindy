// @vitest-environment jsdom

/**
 * UnifiedModelList 纯逻辑单测:并集构建、按 Agent 计数与分歧判定。
 * 可见性 override 走真实 modelVisibilityPrefs(localStorage 由 jsdom 提供,用例间重置)。
 */

import { afterEach, describe, expect, it } from 'vitest';

import { buildUnionRows, countModelsByAgent, isRowDiverged } from '@/components/settings/UnifiedModelList';
import { __resetForTest, setModelVisibility } from '@/state/modelVisibilityPrefs';

import type { CatalogModel, ProviderView } from '@cindy/model-providers';

function model(id: string, contextWindow = 100_000): CatalogModel {
  return { id, name: id, contextWindow, efforts: [], defaultEffort: null } as CatalogModel;
}

const provider = {
  id: 'p1',
  name: 'P1',
  source: 'user',
  agents: ['claude-code', 'codex'],
  auth: { method: 'api-key' },
  routing: {},
  models: {
    'claude-code': [model('shared'), model('cc-only')],
    codex: [model('shared', 272_000), model('codex-only')],
  },
  connected: true,
} as unknown as ProviderView;

afterEach(() => {
  __resetForTest();
});

describe('buildUnionRows', () => {
  it('同 id 跨 agent 合并;行序 = 首 agent 目录序 + 后续 agent 独占追加', () => {
    const rows = buildUnionRows(provider);
    expect(rows.map((r) => r.id)).toEqual(['shared', 'cc-only', 'codex-only']);
    const shared = rows[0];
    expect(shared.avail).toEqual(['claude-code', 'codex']);
    // 各 agent 目录条目独立保留(同名模型元数据可不同:cc 100K / codex 272K)。
    expect(shared.byAgent['claude-code']?.contextWindow).toBe(100_000);
    expect(shared.byAgent.codex?.contextWindow).toBe(272_000);
    expect(rows[1].avail).toEqual(['claude-code']);
    expect(rows[2].avail).toEqual(['codex']);
  });
});

describe('buildUnionRows — 桥接命名空间归一', () => {
  it('routing.modelPrefixes 声明的前缀剥掉后合并为一行,byAgent 保留各端真实 id', () => {
    // OpenAI 形态:codex 原生 gpt-5.5,cc 经 responses-bridge 投影为 chatgpt/gpt-5.5。
    const bridged = {
      id: 'openai',
      name: 'OpenAI',
      source: 'builtin',
      agents: ['claude-code', 'codex'],
      auth: { method: 'oauth' },
      routing: { 'claude-code': { upstream: 'https://x', modelPrefixes: ['chatgpt/'] } },
      models: {
        'claude-code': [model('chatgpt/gpt-5.5')],
        codex: [model('gpt-5.5', 272_000)],
      },
      connected: true,
    } as unknown as ProviderView;
    const rows = buildUnionRows(bridged);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('gpt-5.5');
    expect(rows[0].avail).toEqual(['claude-code', 'codex']);
    // 写开关必须用各端真实 id:cc 端仍是带前缀的目录 id。
    expect(rows[0].byAgent['claude-code']?.id).toBe('chatgpt/gpt-5.5');
    expect(rows[0].byAgent.codex?.id).toBe('gpt-5.5');
  });
});

describe('isRowDiverged', () => {
  it('默认(无 override)不分歧;单端隐藏后分歧;两端同值不分歧', () => {
    const rows = buildUnionRows(provider);
    const shared = rows[0];
    expect(isRowDiverged('p1', shared)).toBe(false);

    setModelVisibility('codex', 'p1', 'shared', false);
    expect(isRowDiverged('p1', shared)).toBe(true);

    setModelVisibility('claude-code', 'p1', 'shared', false);
    expect(isRowDiverged('p1', shared)).toBe(false);
  });

  it('单端可用的模型永不分歧', () => {
    const rows = buildUnionRows(provider);
    const ccOnly = rows[1];
    setModelVisibility('claude-code', 'p1', 'cc-only', false);
    expect(isRowDiverged('p1', ccOnly)).toBe(false);
  });
});

describe('countModelsByAgent', () => {
  it('分别保留每个 Agent 的计数，不汇总成容易误解的模型总数', () => {
    expect(countModelsByAgent(provider)).toEqual([
      { agent: 'claude-code', on: 2, total: 2 },
      { agent: 'codex', on: 2, total: 2 },
    ]);

    setModelVisibility('codex', 'p1', 'shared', false);
    expect(countModelsByAgent(provider)).toEqual([
      { agent: 'claude-code', on: 2, total: 2 },
      { agent: 'codex', on: 1, total: 2 },
    ]);
  });

  it('does not count a newly discovered model with defaultEnabled=false as enabled', () => {
    const withDiscovered = {
      ...provider,
      models: {
        ...provider.models,
        codex: [...(provider.models.codex ?? []), { ...model('discovered'), defaultEnabled: false }],
      },
    } as ProviderView;
    expect(countModelsByAgent(withDiscovered)).toEqual([
      { agent: 'claude-code', on: 2, total: 2 },
      { agent: 'codex', on: 2, total: 3 },
    ]);
  });
});
