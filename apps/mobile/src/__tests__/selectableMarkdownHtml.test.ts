import { describe, expect, it } from 'vitest';

import { buildSelectableMarkdownHtml } from '@/session/selectableMarkdownHtml';

const DOC = [
  '# 标题',        // 0
  '',
  '第一段',        // 2
  '',
  '第二段',        // 4
].join('\n');

describe('buildSelectableMarkdownHtml 渲染态行定位', () => {
  it('带 targetLine 时每个块包 data-src-line 容器(源码起始行)', () => {
    const html = buildSelectableMarkdownHtml(DOC, { targetLine: 3 });
    expect(html).toContain('<div data-src-line="0"><h1>');
    expect(html).toContain('<div data-src-line="2"><p>');
    expect(html).toContain('<div data-src-line="4"><p>');
  });

  it('无 targetLine 时保持原 HTML 结构(不包 data-src-line 容器)', () => {
    expect(buildSelectableMarkdownHtml(DOC)).not.toContain('data-src-line');
  });

  it('targetLine 注入定位脚本(1-based → 0-based),并带闪两下即移除的高亮', () => {
    const html = buildSelectableMarkdownHtml(DOC, { targetLine: 5 });
    expect(html).toContain('n<=4');
    expect(html).toContain('xdt-line-flash');
    // 高亮不驻留:动画两次迭代 + animationend 移除 class。
    expect(html).toContain('ease-in-out 2;');
    expect(html).toContain("addEventListener('animationend'");
    expect(html).toContain('classList.remove');
  });

  it('不传 targetLine 不注入脚本;非法值(0 / 非整数)同样不注入', () => {
    expect(buildSelectableMarkdownHtml(DOC)).not.toContain('<script>');
    expect(buildSelectableMarkdownHtml(DOC, { targetLine: 0 })).not.toContain('<script>');
    expect(buildSelectableMarkdownHtml(DOC, { targetLine: 1.5 })).not.toContain('<script>');
  });
});
