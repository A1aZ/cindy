/**
 * model-route-guard.test.ts —— 停用轴在 main 会话路由边界的准入判定矩阵。
 * 纯函数直测(规则 14);register.ts 的 bootstrapSession / SET_MODEL 只是薄接线。
 */

import { describe, expect, it } from 'vitest';

import { buildRegistry, type Catalog, type CatalogModel, type Provider } from '@cindy/model-providers';

import { checkModelRouteDisabled } from '../model-route-guard.js';

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

const CATALOG: Catalog = {
  providers: [
    provider('alpha', [model('claude-opus-5')]),
    provider('beta', [model('claude-opus-5')]),
  ],
} as Catalog;
const CONNECTED = { alpha: true, beta: true };

function views(access?: Parameters<typeof buildRegistry>[3]) {
  return buildRegistry(CATALOG, CONNECTED, {}, access);
}

describe('checkModelRouteDisabled', () => {
  it('无停用条目 / 目录不认识该模型 ⇒ 放行(不新增拒绝面)', () => {
    expect(checkModelRouteDisabled(views(), 'claude-code', 'claude-opus-5', null)).toBeNull();
    expect(checkModelRouteDisabled(views(), 'claude-code', 'unknown-model', null)).toBeNull();
    expect(
      checkModelRouteDisabled(
        views({ disabledModels: { 'alpha:claude-opus-5': true } }),
        'claude-code',
        'unknown-model',
        'alpha',
      ),
    ).toBeNull();
  });

  it('单份拷贝停用但仍有启用来源 ⇒ 默认路由放行;点名停用的那家 ⇒ 拒绝', () => {
    const v = views({ disabledModels: { 'alpha:claude-opus-5': true } });
    expect(checkModelRouteDisabled(v, 'claude-code', 'claude-opus-5', null)).toBeNull();
    expect(checkModelRouteDisabled(v, 'claude-code', 'claude-opus-5', 'beta')).toBeNull();
    expect(checkModelRouteDisabled(v, 'claude-code', 'claude-opus-5', 'alpha')).toBe(
      'explicit-source-disabled',
    );
  });

  it('全部拷贝停用 ⇒ 无论是否点名来源都拒绝', () => {
    const v = views({
      disabledModels: { 'alpha:claude-opus-5': true, 'beta:claude-opus-5': true },
    });
    expect(checkModelRouteDisabled(v, 'claude-code', 'claude-opus-5', null)).toBe('model-disabled');
    expect(checkModelRouteDisabled(v, 'claude-code', 'claude-opus-5', 'alpha')).toBe(
      'explicit-source-disabled',
    );
  });

  it('供应商级停用与模型级同语义:点名 suspended 来源拒绝,全 suspended 拒绝', () => {
    expect(
      checkModelRouteDisabled(
        views({ disabledProviders: { alpha: true } }),
        'claude-code',
        'claude-opus-5',
        'alpha',
      ),
    ).toBe('explicit-source-disabled');
    expect(
      checkModelRouteDisabled(
        views({ disabledProviders: { alpha: true, beta: true } }),
        'claude-code',
        'claude-opus-5',
        null,
      ),
    ).toBe('model-disabled');
  });

  it('点名来源不提供该模型 ⇒ 放行(交给既有收窄 / preflight)', () => {
    const v = views({ disabledModels: { 'alpha:claude-opus-5': true } });
    expect(checkModelRouteDisabled(v, 'claude-code', 'claude-opus-5', 'nonexistent')).toBeNull();
  });
});
