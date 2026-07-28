import { describe, expect, it } from 'vitest';

import {
  formatSubagentDiagnosticsReminder,
  resolveSubagentModelDefault,
  suggestModelIds,
} from '../subagent-model-default.js';
import type { DiscoveredSubagent } from '../subagent-definitions.js';

function agent(over: Partial<DiscoveredSubagent> & { name: string }): DiscoveredSubagent {
  return {
    filePath: `/home/u/.claude/agents/${over.name}.md`,
    scope: 'user',
    frontmatter: { name: over.name, description: `${over.name} desc` },
    body: `${over.name} prompt`,
    ...over,
  };
}

describe('resolveSubagentModelDefault —— 设不设 env', () => {
  it('没配默认值 → 不设 env(与上线前一致)', () => {
    const r = resolveSubagentModelDefault({
      configuredDefault: undefined,
      discovered: [agent({ name: 'a' })],
    });
    expect(r.envSubagentModel).toBeUndefined();
    expect(r.diagnostics).toEqual([]);
  });

  it('空白字符串也算没配', () => {
    const r = resolveSubagentModelDefault({ configuredDefault: '   ', discovered: [] });
    expect(r.envSubagentModel).toBeUndefined();
  });

  it('没有任何 agent 声明 model → 设 env(内置 agent 也吃到默认值,行为零变化)', () => {
    const r = resolveSubagentModelDefault({
      configuredDefault: 'claude-sonnet-5',
      discovered: [agent({ name: 'a' }), agent({ name: 'b' })],
    });
    expect(r.envSubagentModel).toBe('claude-sonnet-5');
  });

  it('完全没有 agent 文件时也设 env', () => {
    const r = resolveSubagentModelDefault({ configuredDefault: 'haiku', discovered: [] });
    expect(r.envSubagentModel).toBe('haiku');
  });

  it('有任一 agent 声明了 model → 不设 env(让声明生效,这是本次修复的核心)', () => {
    const r = resolveSubagentModelDefault({
      configuredDefault: 'claude-sonnet-5',
      discovered: [
        agent({ name: 'x-search', declaredModel: 'xai/grok-4.5' }),
        agent({ name: 'plain' }),
      ],
    });
    expect(r.envSubagentModel).toBeUndefined();
  });

  it('declaredModel 为 undefined(发现层把 inherit 归一化过)时视作未声明', () => {
    const r = resolveSubagentModelDefault({
      configuredDefault: 'haiku',
      discovered: [agent({ name: 'a', declaredModel: undefined })],
    });
    expect(r.envSubagentModel).toBe('haiku');
  });
});

describe('声明模型的可用性校验', () => {
  const available = ['claude-opus-5', 'claude-sonnet-5', 'xai/grok-4.5', 'xai/grok-4.3'];

  it('声明了不存在的 model → unknown-model,并给出相近候选', () => {
    const r = resolveSubagentModelDefault({
      configuredDefault: undefined,
      discovered: [agent({ name: 'typo', declaredModel: 'xai/grok-9.9' })],
      availableModelIds: available,
    });

    expect(r.diagnostics).toHaveLength(1);
    expect(r.diagnostics[0]).toMatchObject({
      agent: 'typo',
      kind: 'unknown-model',
      declaredModel: 'xai/grok-9.9',
      availableModelCount: 4,
    });
    // 同命名空间的排前面。
    expect(r.diagnostics[0].suggestedModelIds.slice(0, 2)).toEqual(['xai/grok-4.5', 'xai/grok-4.3']);
  });

  it('校验独立于默认值 —— 没配默认值也照样报', () => {
    const r = resolveSubagentModelDefault({
      configuredDefault: undefined,
      discovered: [agent({ name: 'a', declaredModel: 'nope' })],
      availableModelIds: available,
    });
    expect(r.diagnostics.map((d) => d.kind)).toEqual(['unknown-model']);
  });

  it('写错 model 的 agent 仍算「声明了」→ 依然不设 env(不能因为写错就回去覆盖别人)', () => {
    const r = resolveSubagentModelDefault({
      configuredDefault: 'haiku',
      discovered: [agent({ name: 'a', declaredModel: 'nope' })],
      availableModelIds: available,
    });
    expect(r.envSubagentModel).toBeUndefined();
    expect(r.diagnostics).toHaveLength(1);
  });

  it('平台别名放行,不误报', () => {
    const r = resolveSubagentModelDefault({
      configuredDefault: undefined,
      discovered: [
        agent({ name: 'a', declaredModel: 'sonnet' }),
        agent({ name: 'b', declaredModel: 'Opus' }),
        agent({ name: 'c', declaredModel: 'haiku' }),
        agent({ name: 'd', declaredModel: 'fable' }),
      ],
      availableModelIds: available,
    });
    expect(r.diagnostics).toEqual([]);
  });

  it('真实可用的 id 放行', () => {
    const r = resolveSubagentModelDefault({
      configuredDefault: undefined,
      discovered: [agent({ name: 'a', declaredModel: 'xai/grok-4.5' })],
      availableModelIds: available,
    });
    expect(r.diagnostics).toEqual([]);
  });

  it('拿不到可用清单时不做校验(不误报)', () => {
    const r = resolveSubagentModelDefault({
      configuredDefault: undefined,
      discovered: [agent({ name: 'a', declaredModel: 'whatever' })],
    });
    expect(r.diagnostics).toEqual([]);
  });
});

describe('suggestModelIds', () => {
  // 实机踩过的坑:可用清单有 70+ 条,混着 embedding / image / audio 模型,全列既费上下文又误导。
  const many = [
    'claude-opus-5', 'claude-sonnet-5', 'chatgpt/gpt-5.5',
    'xai/grok-4.5', 'xai/grok-4.3', 'xai/grok-code-fast',
    'text-embedding-3-large', 'gpt-image-2', 'elevenlabs/eleven_v3',
    'voyage/voyage-4', 'gemini-3.5-flash', 'deepseek/deepseek-v4-pro',
  ];

  it('同命名空间前缀优先', () => {
    const s = suggestModelIds('xai/grok-9.9-nope', many);
    expect(s.slice(0, 3)).toEqual(['xai/grok-4.5', 'xai/grok-4.3', 'xai/grok-code-fast']);
  });

  it('无命名空间时按词干匹配', () => {
    const s = suggestModelIds('grok-nine', many);
    expect(s[0]).toContain('grok');
  });

  it('最多 8 条,不倾倒整份清单', () => {
    expect(suggestModelIds('nonsense', many)).toHaveLength(8);
  });

  it('同档内保持目录原序(结果稳定可预期)', () => {
    const s = suggestModelIds('xai/x', ['xai/b', 'xai/a']);
    expect(s).toEqual(['xai/b', 'xai/a']);
  });
});

describe('formatSubagentDiagnosticsReminder', () => {
  it('无诊断 → null(不占用户上下文)', () => {
    expect(formatSubagentDiagnosticsReminder([])).toBeNull();
  });

  it('渲染成 system-reminder,含 agent 名、路径、候选与「另有 N 个」', () => {
    const text = formatSubagentDiagnosticsReminder([
      {
        agent: 'x-search',
        filePath: '/home/u/.claude/agents/x-search.md',
        kind: 'unknown-model',
        declaredModel: 'xai/grok-9.9',
        suggestedModelIds: ['xai/grok-4.5'],
        availableModelCount: 70,
      },
    ]);

    expect(text).toContain('<system-reminder>');
    expect(text).toContain('</system-reminder>');
    expect(text).toContain('x-search');
    expect(text).toContain('/home/u/.claude/agents/x-search.md');
    expect(text).toContain('xai/grok-9.9');
    expect(text).toContain('xai/grok-4.5');
    // 诚实说明只列了一部分,而不是假装这就是全部。
    expect(text).toContain('另有 69 个');
    // 不许模型擅自改用户文件。
    expect(text).toContain('不要主动改动文件');
  });

  it('候选恰好覆盖全部时不说「另有」', () => {
    const text = formatSubagentDiagnosticsReminder([
      {
        agent: 'a',
        filePath: '/p/a.md',
        kind: 'unknown-model',
        declaredModel: 'nope',
        suggestedModelIds: ['m1', 'm2'],
        availableModelCount: 2,
      },
    ]);
    expect(text).not.toContain('另有');
  });
});
