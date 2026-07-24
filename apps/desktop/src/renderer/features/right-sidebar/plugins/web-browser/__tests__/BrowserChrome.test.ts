// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement, createRef } from 'react';

import { BrowserChrome, type BrowserChromeHandle } from '../BrowserChrome';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

// Radix DropdownMenu 在 jsdom 下的 pointer 交互不可靠(hasPointerCapture 等未实现),
// 沿用仓库既定测试模式:mock 成始终展开的直通组件,Item 渲染成普通 <button>,
// 把 Radix 的 onSelect 映射到 onClick、透传 disabled —— 这样能直接断言菜单项的
// 可用性与回调,不依赖真实菜单开合。
vi.mock('@/components/ui/dropdown-menu', () => {
  const react = require('react') as typeof import('react');
  return {
    DropdownMenu: ({ children }: { children: React.ReactNode }) =>
      react.createElement(react.Fragment, null, children),
    DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) =>
      react.createElement(react.Fragment, null, children),
    DropdownMenuContent: ({ children }: { children: React.ReactNode }) =>
      react.createElement('div', null, children),
    DropdownMenuItem: ({
      children,
      onSelect,
      disabled,
    }: {
      children: React.ReactNode;
      onSelect?: () => void;
      disabled?: boolean;
    }) =>
      react.createElement(
        'button',
        { type: 'button', disabled, onClick: () => onSelect?.() },
        children,
      ),
  };
});

function renderChrome(
  url = 'https://www.taptap.cn/',
  extra: { commentSupported?: boolean } = {},
) {
  const onNavigate = vi.fn();
  const onOpenInSystemBrowser = vi.fn();
  const onCopyLink = vi.fn();
  const ref = createRef<BrowserChromeHandle>();
  render(
    createElement(BrowserChrome, {
      ref,
      url,
      isLoading: false,
      canGoBack: false,
      canGoForward: false,
      onNavigate,
      onReload: vi.fn(),
      onStop: vi.fn(),
      onGoBack: vi.fn(),
      onGoForward: vi.fn(),
      onCaptureScreenshot: vi.fn(),
      commentActive: false,
      onToggleComment: vi.fn(),
      onOpenInSystemBrowser,
      onCopyLink,
      ...extra,
    }),
  );
  return { onNavigate, onOpenInSystemBrowser, onCopyLink, ref };
}

describe('BrowserChrome', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('submits Ctrl+Enter once and suppresses the following blur submit', () => {
    const { onNavigate } = renderChrome();

    fireEvent.click(screen.getByRole('button', { name: 'https://www.taptap.cn/' }));
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'google' } });
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
    fireEvent.blur(input);

    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(onNavigate).toHaveBeenCalledWith('https://www.google.com');
  });

  it('renders the page-comment button by default (commentSupported defaults to true)', () => {
    renderChrome();
    expect(
      screen.getByRole('button', { name: 'rightSidebar.browser.comment' }),
    ).toBeTruthy();
  });

  it('hides the page-comment button when commentSupported is false (detached sidebar window has no composer)', () => {
    renderChrome('https://www.taptap.cn/', { commentSupported: false });
    expect(
      screen.queryByRole('button', { name: 'rightSidebar.browser.comment' }),
    ).toBeNull();
  });

  it('fires open-in-system-browser and copy-link from the more menu when the link is valid', () => {
    const { onOpenInSystemBrowser, onCopyLink } = renderChrome();

    fireEvent.click(
      screen.getByRole('button', { name: 'rightSidebar.browser.openInSystemBrowser' }),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'rightSidebar.browser.copyLink' }),
    );

    expect(onOpenInSystemBrowser).toHaveBeenCalledTimes(1);
    expect(onCopyLink).toHaveBeenCalledTimes(1);
  });

  it('disables both more-menu items when there is no valid link (about:blank new tab)', () => {
    const { onOpenInSystemBrowser, onCopyLink } = renderChrome('about:blank');

    const openItem = screen.getByRole('button', {
      name: 'rightSidebar.browser.openInSystemBrowser',
    }) as HTMLButtonElement;
    const copyItem = screen.getByRole('button', {
      name: 'rightSidebar.browser.copyLink',
    }) as HTMLButtonElement;

    expect(openItem.disabled).toBe(true);
    expect(copyItem.disabled).toBe(true);

    // disabled 的 <button> 在 jsdom 里点击不触发 onClick —— 断言回调没被调。
    fireEvent.click(openItem);
    fireEvent.click(copyItem);
    expect(onOpenInSystemBrowser).not.toHaveBeenCalled();
    expect(onCopyLink).not.toHaveBeenCalled();
  });
});
