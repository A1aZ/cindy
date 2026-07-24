/**
 * hookWorkspacePrefsLogic 单测: 换 agent / 换 model 的联动 patch 与
 * slack-hook-server bot.ts 的 /model 卡校准语义对齐(两渠道同一份数据)。
 */

import { describe, expect, it } from 'vitest';

import {
  patchForAgentChange,
  patchForModelChange,
  resolveEffectiveRow,
  type PrefsAgentCaps,
} from '../hookWorkspacePrefsLogic';

const CLAUDE_CAPS: PrefsAgentCaps = {
  models: [
    { id: 'claude-opus-4-8', efforts: ['low', 'high'], defaultEffort: 'high' },
    { id: 'claude-sonnet-5', efforts: [], defaultEffort: null },
  ],
  permissionModes: [{ id: 'ask' }, { id: 'acceptEdits' }, { id: 'bypassPermissions' }],
};

const CODEX_CAPS: PrefsAgentCaps = {
  models: [{ id: 'gpt-5.5', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium' }],
  permissionModes: [{ id: 'ask' }, { id: 'bypassPermissions' }],
};

describe('patchForAgentChange', () => {
  it('换 agent: 清 model/effort; 权限档兼容则保留', () => {
    expect(patchForAgentChange('codex', { permissionMode: 'ask' }, CODEX_CAPS)).toEqual({
      agentKind: 'codex',
      model: null,
      effort: null,
    });
  });

  it('换 agent: 权限档不被新组支持时一并清空(claude 专属 acceptEdits -> codex)', () => {
    expect(patchForAgentChange('codex', { permissionMode: 'acceptEdits' }, CODEX_CAPS)).toEqual({
      agentKind: 'codex',
      model: null,
      effort: null,
      permissionMode: null,
    });
  });

  it('agent 置 null(跟随默认): 整组清空, 权限档保留(派发侧自校验)', () => {
    expect(patchForAgentChange(null, { permissionMode: 'ask' }, null)).toEqual({
      agentKind: null,
      model: null,
      effort: null,
    });
  });

  it('能力未就绪(caps null)时保守清权限档 —— 无从判断兼容性', () => {
    expect(patchForAgentChange('codex', { permissionMode: 'acceptEdits' }, null)).toEqual({
      agentKind: 'codex',
      model: null,
      effort: null,
      permissionMode: null,
    });
  });
});

describe('patchForModelChange', () => {
  it('换 model: agentKind 配对写入; effort 兼容则不动', () => {
    expect(
      patchForModelChange('claude-code', 'claude-opus-4-8', { effort: 'low' }, CLAUDE_CAPS),
    ).toEqual({ model: 'claude-opus-4-8', agentKind: 'claude-code' });
  });

  it('换 model: effort 不兼容时校准到模型默认档(无默认档则清空)', () => {
    expect(
      patchForModelChange('codex', 'gpt-5.5', { effort: 'ultra' }, CODEX_CAPS),
    ).toEqual({ model: 'gpt-5.5', agentKind: 'codex', effort: 'medium' });
    expect(
      patchForModelChange('claude-code', 'claude-sonnet-5', { effort: 'low' }, CLAUDE_CAPS),
    ).toEqual({ model: 'claude-sonnet-5', agentKind: 'claude-code', effort: null });
  });

  it('model 置 null: model/effort 一起清(effort 依附于模型)', () => {
    expect(patchForModelChange('codex', null, { effort: 'high' }, CODEX_CAPS)).toEqual({
      model: null,
      effort: null,
    });
  });
});

describe('resolveEffectiveRow(当前生效默认值解析, 对齐 main defaults.ts)', () => {
  const IM = {
    agentKind: 'claude-code',
    agents: {
      'claude-code': { model: 'claude-opus-4-8', effort: 'xhigh' },
      codex: { model: 'gpt-5.5', effort: 'ultra' }, // ultra 非法档, 应回落模型默认
    },
  };
  const capsFor = (k: string) => (k === 'claude-code' ? CLAUDE_CAPS : k === 'codex' ? CODEX_CAPS : null);
  const NULLS = { agentKind: null, model: null, effort: null, permissionMode: null };

  it('全默认: agent/model/effort 逐级从桌面默认解析, 权限恒 bypass', () => {
    const eff = resolveEffectiveRow(NULLS, IM, capsFor);
    expect(eff.agentKind).toEqual({ id: 'claude-code', isDefault: true, defaultId: 'claude-code' });
    expect(eff.model).toEqual({ id: 'claude-opus-4-8', isDefault: true, defaultId: 'claude-opus-4-8' });
    // claude-opus-4-8 支持 xhigh? CLAUDE_CAPS efforts ['low','high'] -> 草稿 xhigh 非法, 回落 defaultEffort high
    expect(eff.effort).toEqual({ id: 'high', isDefault: true, defaultId: 'high' });
    expect(eff.permissionMode).toEqual({
      id: 'bypassPermissions',
      isDefault: true,
      defaultId: 'bypassPermissions',
    });
  });

  it('显式 agent 改变下游默认解析(codex 草稿档非法 -> 模型默认档)', () => {
    const eff = resolveEffectiveRow({ ...NULLS, agentKind: 'codex' }, IM, capsFor);
    expect(eff.agentKind.isDefault).toBe(false);
    expect(eff.model).toEqual({ id: 'gpt-5.5', isDefault: true, defaultId: 'gpt-5.5' });
    expect(eff.effort).toEqual({ id: 'medium', isDefault: true, defaultId: 'medium' });
  });

  it('草稿模型不在能力清单: 默认回落清单第一个', () => {
    const im = { ...IM, agents: { ...IM.agents, 'claude-code': { model: 'gone-model', effort: 'low' } } };
    const eff = resolveEffectiveRow(NULLS, im, capsFor);
    expect(eff.model.id).toBe('claude-opus-4-8'); // CLAUDE_CAPS 第一个
  });

  it('显式模型不支持调档: effort 生效值与默认均为 null(无)', () => {
    const eff = resolveEffectiveRow({ ...NULLS, model: 'claude-sonnet-5' }, IM, capsFor);
    expect(eff.model.isDefault).toBe(false);
    expect(eff.effort).toEqual({ id: null, isDefault: true, defaultId: null });
  });

  it('显式值优先且 isDefault=false; imDefaults 未就绪时尽量退化', () => {
    const eff = resolveEffectiveRow(
      { agentKind: 'codex', model: 'gpt-5.5', effort: 'low', permissionMode: 'ask' },
      null,
      capsFor,
    );
    expect(eff.agentKind).toMatchObject({ id: 'codex', isDefault: false });
    expect(eff.effort).toMatchObject({ id: 'low', isDefault: false });
    expect(eff.permissionMode).toMatchObject({ id: 'ask', isDefault: false });
    // imDefaults null: 默认 agent 退化 claude-code, 默认模型退化清单第一个
    const eff2 = resolveEffectiveRow({ agentKind: null, model: null, effort: null, permissionMode: null }, null, capsFor);
    expect(eff2.agentKind.defaultId).toBe('claude-code');
    expect(eff2.model.defaultId).toBe('claude-opus-4-8');
  });
});
