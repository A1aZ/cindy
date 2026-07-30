import { describe, it, expect } from 'vitest';

import {
  DEFAULT_DRAFT_SESSION_TITLE,
  isDefaultDraftSessionTitle,
  normalizeAutoTitle,
} from '../sessionTitle.js';

describe('normalizeAutoTitle', () => {
  it('折叠空白 → trim → 截断 40 字(先 trim 再截断)', () => {
    expect(normalizeAutoTitle('  帮我\n排查  登录失败 ')).toBe('帮我 排查 登录失败');
    expect(normalizeAutoTitle(`\n${' '.repeat(50)}real text`)).toBe('real text');
    expect(normalizeAutoTitle('排'.repeat(60))).toBe('排'.repeat(40));
    expect(normalizeAutoTitle('   ')).toBe('');
  });

  it('幂等:对已归一化的串再跑一次结果不变', () => {
    // renderer 的乐观预览与 main 的权威占位都跑这个函数,两次结果必须逐字一致 ——
    // 否则回流时侧边栏标题会跳变一次。
    const once = normalizeAutoTitle('  帮我\n排查  登录失败 ');
    expect(normalizeAutoTitle(once)).toBe(once);
  });

  it('先 trim 的串与原串算出同一个结果', () => {
    // 权威路径会先经 projectLiteralUserText / stripMentionTokens(两者都只 trim),
    // 乐观预览直接拿原文;两条输入必须收敛到同一个标题。
    const raw = '   帮我排查登录失败   ';
    expect(normalizeAutoTitle(raw.trim())).toBe(normalizeAutoTitle(raw));
  });
});

describe('isDefaultDraftSessionTitle', () => {
  it('只认建会话时的裸默认哨兵', () => {
    expect(isDefaultDraftSessionTitle(DEFAULT_DRAFT_SESSION_TITLE)).toBe(true);
    expect(isDefaultDraftSessionTitle('帮我排查登录失败')).toBe(false);
    expect(isDefaultDraftSessionTitle('')).toBe(false);
    expect(isDefaultDraftSessionTitle(null)).toBe(false);
    expect(isDefaultDraftSessionTitle(undefined)).toBe(false);
  });

  it('不做大小写 / 空白归一 —— 用户改成近似串是合法自定义标题', () => {
    // 归一化比较会把用户手动改的名误判成系统占位,进而被自动起名覆盖掉。
    expect(isDefaultDraftSessionTitle('new maker')).toBe(false);
    expect(isDefaultDraftSessionTitle('NEW MAKER')).toBe(false);
    expect(isDefaultDraftSessionTitle(' New Maker ')).toBe(false);
  });

  it('哨兵值保持 locale-independent 字面量', () => {
    // 它是 SQLite 列默认值,又要跨设备 / 跨语言逐字比对,还是条件写的期望值。
    // 本地化会让哨兵匹配失效、自动起名永久跳过。
    expect(DEFAULT_DRAFT_SESSION_TITLE).toBe('New Maker');
  });
});
