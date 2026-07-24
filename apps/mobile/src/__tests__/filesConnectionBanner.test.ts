import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('mobile files page connection banner noise budget', () => {
  it('renders the connection banner only when the link is degraded, not as a resident bar', () => {
    const source = readFileSync(resolve(process.cwd(), 'app/files/[sessionId].tsx'), 'utf8');
    // 页面只有这一处 ConnectionBanner,下面的属性断言直接查全文即可绑定到它。
    expect(source.split('<ConnectionBanner').length).toBe(2);

    // banner 渲染条件与会话页对齐(useShowConnectionBanner):请求级 error /
    // 可分类连接问题立即显示;普通弱网断线持续超过防闪窗口后也显示;
    // 连接正常时不渲染常驻状态条。
    expect(source).toContain('useShowConnectionBanner(status, error, connectionIssue)');
    expect(source).toContain('{showConnectionBanner ? (');
    expect(source).toContain('density="compact"');
    expect(source).toContain('variant="inline"');
  });

  it('keeps the footer realtime-sync line as the only resident connection hint', () => {
    const source = readFileSync(resolve(process.cwd(), 'app/files/[sessionId].tsx'), 'utf8');
    expect(source).toContain("已连接 · 实时同步");
  });
});
