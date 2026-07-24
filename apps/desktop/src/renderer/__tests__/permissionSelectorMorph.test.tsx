// @vitest-environment jsdom

/**
 * PermissionSelector × MorphPopover(容器形变试点)行为回归:
 * - 点击 trigger 打开 listbox(portal 渲染,四档全在)
 * - 选项点击回调 onPermissionModeChange 并收合
 * - Esc / outside pointerdown 关闭
 * - 形变期间 trigger wrapper 隐形,收合后复形(「不是盖一层」的核心语义)
 * jsdom 无布局引擎(rect 全 0),几何/丝滑度不在此测——那部分靠 docs/design-rules/cindy-design-system.md
 * §14.4 的实测要求与人工走查兜底。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    // triggerAria 这类 key 用 {label} 插值,mock 直接回吐 label,让按钮可及名可断言
    t: (_key: string, opts?: { defaultValue?: string; label?: string }) =>
      opts?.defaultValue ?? (opts?.label ? String(opts.label) : _key),
  }),
}));

const PERMISSION_MODES = [
  { id: 'ask', displayName: '默认权限', description: 'ask desc' },
  { id: 'acceptEdits', displayName: '允许编辑', description: 'edits desc' },
  { id: 'auto', displayName: '自动审批', description: 'auto desc' },
  { id: 'bypassPermissions', displayName: '完全访问', description: 'bypass desc' },
];

vi.mock('@/hooks/useAgentCapabilities', () => ({
  useAgentCapabilities: () => ({ capabilities: { permissionModes: PERMISSION_MODES } }),
}));

import { PermissionSelector } from '../components/new-chat/PermissionSelector';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderSelector(overrides: Partial<Parameters<typeof PermissionSelector>[0]> = {}) {
  const onChange = vi.fn();
  const utils = render(
    <PermissionSelector permissionMode="ask" onPermissionModeChange={onChange} {...overrides} />,
  );
  return { onChange, ...utils };
}

function getTrigger(): HTMLElement {
  return screen.getByRole('button', { name: /默认权限|完全访问/ });
}

describe('PermissionSelector (MorphPopover pilot)', () => {
  // 2026-07-22:PermissionSelector 只在 composer 使用,已统一为「恒走脱身上浮 morph」——
  // 移除 origin/main 的 useMorphPopover opt-in/Radix 回退开关,故删去原「默认用 Radix」用例。
  it('点击 trigger 打开 listbox,四档选项齐全,aria-expanded 同步', async () => {
    renderSelector();
    const trigger = getTrigger();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(trigger);
    const listbox = await screen.findByRole('listbox');
    expect(listbox).toBeTruthy();
    expect(screen.getAllByRole('option')).toHaveLength(4);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    // 选中档正确标记(焦点策略 2026-07-23 改回落首个可交互项,恢复键盘可达性,见 codex review)
    const selected = screen
      .getAllByRole('option')
      .find((o) => o.getAttribute('aria-selected') === 'true');
    expect(selected).toBeTruthy();
  });

  it('点击选项回调 onPermissionModeChange 并收合卸载', async () => {
    const { onChange } = renderSelector();
    fireEvent.click(getTrigger());
    await screen.findByRole('listbox');

    fireEvent.click(screen.getByText('完全访问'));
    expect(onChange).toHaveBeenCalledWith('bypassPermissions');
    // 收合动画(300ms+20)后 portal 卸载
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull(), { timeout: 1500 });
  });

  it('Esc 关闭;outside pointerdown 关闭', async () => {
    renderSelector();
    fireEvent.click(getTrigger());
    await screen.findByRole('listbox');
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull(), { timeout: 1500 });

    fireEvent.click(getTrigger());
    await screen.findByRole('listbox');
    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull(), { timeout: 1500 });
  });

  it('脱身上浮:trigger 全程可见,再点 trigger 即关闭(toggle)', async () => {
    renderSelector();
    const trigger = getTrigger();
    const wrap = trigger.closest('span.relative') as HTMLElement;
    expect(wrap).toBeTruthy();

    fireEvent.click(trigger);
    await screen.findByRole('listbox');
    // 脱身上浮语义(2026-07-22 定稿):chip 不隐藏,保住「原地再点一下收起」
    expect(wrap.style.visibility).not.toBe('hidden');

    fireEvent.click(trigger);
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull(), { timeout: 1500 });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('disabled 时点击不打开', () => {
    renderSelector({ disabled: true });
    fireEvent.click(screen.getByRole('button', { name: /默认权限/ }));
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});
