import { describe, expect, it } from 'vitest';

import { prependSystemReminder } from '../index.js';

const REMINDER = '<system-reminder>诊断</system-reminder>';

describe('prependSystemReminder', () => {
  it('字符串 content:提醒放在用户文本之前', () => {
    expect(prependSystemReminder('帮我改代码', REMINDER)).toBe(`${REMINDER}\n\n帮我改代码`);
  });

  it('block 数组 content:插一个 text block 到最前面', () => {
    const out = prependSystemReminder(
      [{ type: 'text', text: '看这张图' }, { type: 'image', path: '/a.png' }],
      REMINDER,
    );
    expect(out).toEqual([
      { type: 'text', text: REMINDER },
      { type: 'text', text: '看这张图' },
      { type: 'image', path: '/a.png' },
    ]);
  });

  // 回归:/compact 这类内置命令是「把 /<name> 当 prompt 前缀原样发给 SDK」来识别的
  // (commands.ts),前面插任何东西都会让 SDK 当普通文本处理,命令静默不执行。
  it('斜杠命令原样返回,不被前置(否则 SDK 认不出命令)', () => {
    expect(prependSystemReminder('/compact 保留结论', REMINDER)).toBe('/compact 保留结论');
    expect(prependSystemReminder('/context', REMINDER)).toBe('/context');
  });

  it('斜杠命令前有空白也照样识别', () => {
    expect(prependSystemReminder('  /compact', REMINDER)).toBe('  /compact');
  });

  it('block 形态的斜杠命令同样跳过(按第一个 text block 判定)', () => {
    const content = [{ type: 'text', text: '/context' }];
    expect(prependSystemReminder(content, REMINDER)).toBe(content);
  });

  it('正文里出现斜杠但不在开头 → 照常前置', () => {
    expect(prependSystemReminder('看 src/a.ts', REMINDER)).toBe(`${REMINDER}\n\n看 src/a.ts`);
  });

  it('返回值是否 === 入参,正是调用方判断「提醒有没有真带出去」的依据', () => {
    const slash = '/compact';
    expect(prependSystemReminder(slash, REMINDER)).toBe(slash);
    expect(prependSystemReminder('普通消息', REMINDER)).not.toBe('普通消息');
  });
});
