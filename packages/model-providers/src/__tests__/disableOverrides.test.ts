/**
 * 「模型 / 供应商停用」(disableOverrides)行为锁:
 *   1. buildRegistry 烘焙 —— suspended / model.disabled 标志按 override 落位;
 *      无停用条目时 models 原引用透传(热路径零额外分配)。
 *   2. rail 过滤 —— connectedProvidersForAgent / sourcesForModel 剔除 suspended
 *      供应商(⇒ effectiveSourceIdForModel 不会解析到停用来源)。
 *   3. 标准派生准入 —— deriveModelList / deriveModelSections 剔除 disabled 模型与
 *      非 agent 分组的能力模型(image/embedding 等);keepSelected 豁免保留停用的
 *      当前选中行(运行中的会话不打断)。
 */

import { describe, expect, it } from 'vitest';

import { buildRegistry, connectedProvidersForAgent, effectiveSourceIdForModel, sourcesForModel } from '../registry.js';
import { deriveModelList, deriveModelSections } from '../modelList.js';
import { isModelDisabled, isProviderDisabled, modelDisableKey } from '../disableOverrides.js';
import type { Catalog, CatalogModel, Provider } from '../types.js';

function model(id: string, extra: Partial<CatalogModel> = {}): CatalogModel {
  return { id, name: id, contextWindow: 200_000, efforts: [], defaultEffort: null, ...extra };
}

function provider(id: string, models: CatalogModel[]): Provider {
  return {
    id,
    name: id,
    source: 'builtin',
    agents: ['claude-code'],
    auth: { method: 'api_key' },
    routing: { 'claude-code': { wireProtocol: 'anthropic-messages', authStrategy: 'api_key' } as never },
    models: { 'claude-code': models },
  };
}

const CATALOG: Catalog = {
  providers: [
    provider('alpha', [model('claude-opus-5'), model('claude-sonnet-5'), model('gpt-image-2')]),
    provider('beta', [model('claude-opus-5')]),
  ],
} as Catalog;

const ALL_CONNECTED = { alpha: true, beta: true };

describe('disableOverrides 决策函数', () => {
  it('key 形状与真值表', () => {
    expect(modelDisableKey('alpha', 'claude-opus-5')).toBe('alpha:claude-opus-5');
    const access = { disabledModels: { 'alpha:claude-opus-5': true }, disabledProviders: { beta: true } };
    expect(isModelDisabled(access, 'alpha', 'claude-opus-5')).toBe(true);
    expect(isModelDisabled(access, 'beta', 'claude-opus-5')).toBe(false);
    expect(isProviderDisabled(access, 'beta')).toBe(true);
    expect(isProviderDisabled(access, 'alpha')).toBe(false);
    expect(isModelDisabled(undefined, 'alpha', 'claude-opus-5')).toBe(false);
    expect(isProviderDisabled(undefined, 'alpha')).toBe(false);
  });
});

describe('buildRegistry 烘焙', () => {
  it('无停用条目时 models 原引用透传(零额外分配)', () => {
    const views = buildRegistry(CATALOG, ALL_CONNECTED, {}, { disabledModels: {}, disabledProviders: {} });
    expect(views[0].models).toBe(CATALOG.providers[0].models);
    expect(views[0].suspended).toBeUndefined();
  });

  it('model 停用条目烘焙成 disabled 标志,只落在点名的 (供应商, 模型)', () => {
    const views = buildRegistry(CATALOG, ALL_CONNECTED, {}, {
      disabledModels: { 'alpha:claude-opus-5': true },
    });
    const alpha = views.find((v) => v.id === 'alpha')!;
    const beta = views.find((v) => v.id === 'beta')!;
    expect(alpha.models['claude-code']!.find((m) => m.id === 'claude-opus-5')!.disabled).toBe(true);
    expect(alpha.models['claude-code']!.find((m) => m.id === 'claude-sonnet-5')!.disabled).toBeUndefined();
    expect(beta.models['claude-code']!.find((m) => m.id === 'claude-opus-5')!.disabled).toBeUndefined();
  });

  it('供应商停用 ⇒ suspended 标志;connected 保持真实连接态', () => {
    const views = buildRegistry(CATALOG, ALL_CONNECTED, {}, { disabledProviders: { beta: true } });
    const beta = views.find((v) => v.id === 'beta')!;
    expect(beta.suspended).toBe(true);
    expect(beta.connected).toBe(true);
  });
});

describe('rail 过滤(suspended)', () => {
  const views = buildRegistry(CATALOG, ALL_CONNECTED, {}, { disabledProviders: { alpha: true } });

  it('connectedProvidersForAgent 剔除 suspended 供应商', () => {
    expect(connectedProvidersForAgent(views, 'claude-code').map((p) => p.id)).toEqual(['beta']);
  });

  it('sourcesForModel / effectiveSourceIdForModel 不解析到 suspended 来源', () => {
    expect(sourcesForModel(views, 'claude-opus-5', 'claude-code').map((p) => p.id)).toEqual(['beta']);
    expect(effectiveSourceIdForModel(views, 'alpha', 'claude-opus-5', 'claude-code')).toBe('beta');
  });
});

describe('标准派生准入(disabled + 能力模型硬排除)', () => {
  const views = buildRegistry(CATALOG, ALL_CONNECTED, {}, {
    disabledModels: { 'alpha:claude-sonnet-5': true },
  });

  it('deriveModelList 剔除 disabled 模型与 image 等能力模型', () => {
    const ids = deriveModelList({ providers: views, agent: 'claude-code' }).map((m) => m.id);
    expect(ids).toEqual(['claude-opus-5']);
  });

  it('deriveModelSections 同口径;keepSelected 豁免保留停用的选中行', () => {
    const sections = deriveModelSections({
      providers: views,
      agent: 'claude-code',
      providerScope: 'as-given',
      keepSelected: { providerId: 'alpha', modelId: 'claude-sonnet-5' },
    });
    const alpha = sections.find((s) => s.provider.id === 'alpha')!;
    // 停用的选中行豁免保留(运行中的会话不打断);image 能力模型仍被硬排除。
    expect(alpha.models.map((m) => m.id).sort()).toEqual(['claude-opus-5', 'claude-sonnet-5']);
  });
});
