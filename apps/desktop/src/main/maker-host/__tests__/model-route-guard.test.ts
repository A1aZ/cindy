/**
 * model-route-guard.test.ts —— 停用轴在 main 会话路由边界的三态裁决矩阵。
 * 纯函数直测(规则 14);register.ts 的 bootstrapSession / SET_MODEL / agent-switch
 * 只是薄接线。语义:pass = 不涉停用;reroute = 隐式默认落点被停用但有启用替代拷贝
 * (调用方以显式来源落地);reject = 显式点名停用来源 / 全部已连接拷贝停用。
 */

import { describe, expect, it } from 'vitest';

import { buildRegistry, type Catalog, type CatalogModel, type Provider } from '@cindy/model-providers';

import { checkModelRoute } from '../model-route-guard.js';

function model(id: string, extra: Partial<CatalogModel> = {}): CatalogModel {
  return { id, name: id, contextWindow: 200_000, efforts: [], defaultEffort: null, ...extra };
}

function provider(id: string, models: CatalogModel[]): Provider {
  return {
    id,
    name: id,
    source: 'builtin',
    agents: ['claude-code'],
    auth: { method: 'apiKey' },
    routing: { 'claude-code': { wireProtocol: 'anthropic-messages', authStrategy: 'api_key' } as never },
    models: { 'claude-code': models },
  };
}

// xd 是 claude-code 的原生默认来源(nativeDefaultSourceId 口径),anthropic 是替代拷贝。
const CATALOG: Catalog = {
  providers: [
    provider('xd', [model('claude-opus-5')]),
    provider('anthropic', [model('claude-opus-5')]),
  ],
} as Catalog;

function views(
  access?: Parameters<typeof buildRegistry>[3],
  connected: Record<string, boolean> = { xd: true, anthropic: true },
) {
  return buildRegistry(CATALOG, connected, {}, access);
}

describe('checkModelRoute', () => {
  it('无停用条目 / 目录不认识该模型 ⇒ pass(不新增拒绝面)', () => {
    expect(checkModelRoute(views(), 'claude-code', 'claude-opus-5', null)).toEqual({ kind: 'pass' });
    expect(checkModelRoute(views(), 'claude-code', 'unknown-model', null)).toEqual({ kind: 'pass' });
  });

  it('显式点名:停用的来源 reject;启用的来源 / 不提供该模型的来源 pass', () => {
    const v = views({ disabledModels: { 'xd:claude-opus-5': true } });
    expect(checkModelRoute(v, 'claude-code', 'claude-opus-5', 'xd')).toEqual({
      kind: 'reject',
      reason: 'explicit-source-disabled',
    });
    expect(checkModelRoute(v, 'claude-code', 'claude-opus-5', 'anthropic')).toEqual({ kind: 'pass' });
    expect(checkModelRoute(v, 'claude-code', 'claude-opus-5', 'nonexistent')).toEqual({ kind: 'pass' });
  });

  it('隐式来源:原生默认落点(xd)被停用且替代拷贝已连接启用 ⇒ reroute 到替代来源', () => {
    // 实际路由层对隐式来源走原生默认、不查停用标志 —— 仅放行等于继续用停用拷贝
    // 付费,必须显式改路由(PR #744 review 第三轮)。
    const v = views({ disabledModels: { 'xd:claude-opus-5': true } });
    expect(checkModelRoute(v, 'claude-code', 'claude-opus-5', null)).toEqual({
      kind: 'reroute',
      providerId: 'anthropic',
    });
  });

  it('隐式来源:替代拷贝存在但**未连接** ⇒ reject(不能把会话路由到连不上的来源)', () => {
    const v = views(
      { disabledModels: { 'xd:claude-opus-5': true } },
      { xd: true, anthropic: false },
    );
    expect(checkModelRoute(v, 'claude-code', 'claude-opus-5', null)).toEqual({
      kind: 'reject',
      reason: 'model-disabled',
    });
  });

  it('隐式来源:原生默认落点未被停用 ⇒ pass,不改变既有路由', () => {
    const v = views({ disabledModels: { 'anthropic:claude-opus-5': true } });
    expect(checkModelRoute(v, 'claude-code', 'claude-opus-5', null)).toEqual({ kind: 'pass' });
  });

  it('零已连接来源 ⇒ pass(连接域问题,交给既有错误路径)', () => {
    const v = views(
      { disabledModels: { 'xd:claude-opus-5': true, 'anthropic:claude-opus-5': true } },
      { xd: false, anthropic: false },
    );
    expect(checkModelRoute(v, 'claude-code', 'claude-opus-5', null)).toEqual({ kind: 'pass' });
  });

  it('能力模型(图像/视频等分组)⇒ reject capability-model(隐式与显式点名同判)', () => {
    // 老控制端可经 allowlisted 通道直接点名图像模型当对话模型 —— 选择器的硬排除
    // 帮不上,必须在同一边界拒绝(PR #744 review 第四轮)。
    const catalog = {
      providers: [provider('xd', [model('seedream-5', { group: 'image' })])],
    } as Catalog;
    const v = buildRegistry(catalog, { xd: true }, {});
    expect(checkModelRoute(v, 'claude-code', 'seedream-5', null)).toEqual({
      kind: 'reject',
      reason: 'capability-model',
    });
    expect(checkModelRoute(v, 'claude-code', 'seedream-5', 'xd')).toEqual({
      kind: 'reject',
      reason: 'capability-model',
    });
  });

  it('供应商级停用与模型级同语义:点名 suspended 来源 reject;默认落点 suspended 且无替代 ⇒ reject', () => {
    expect(
      checkModelRoute(views({ disabledProviders: { xd: true } }), 'claude-code', 'claude-opus-5', 'xd'),
    ).toEqual({ kind: 'reject', reason: 'explicit-source-disabled' });
    expect(
      checkModelRoute(
        views({ disabledProviders: { xd: true, anthropic: true } }),
        'claude-code',
        'claude-opus-5',
        null,
      ),
    ).toEqual({ kind: 'reject', reason: 'model-disabled' });
    // suspended 默认落点 + 启用替代 ⇒ reroute。
    expect(
      checkModelRoute(views({ disabledProviders: { xd: true } }), 'claude-code', 'claude-opus-5', null),
    ).toEqual({ kind: 'reroute', providerId: 'anthropic' });
  });
});
