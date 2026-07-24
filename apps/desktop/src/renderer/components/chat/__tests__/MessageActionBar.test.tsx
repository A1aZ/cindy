// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: {
    Root: ({ children }: { children: ReactNode }) => <>{children}</>,
    Trigger: ({ children }: { children: ReactNode }) => <>{children}</>,
    Content: ({ children }: { children: ReactNode }) => <>{children}</>,
  },
}));

vi.mock('@/hooks/useRelativeTime', () => ({
  useRelativeTime: () => 'just now',
  formatAbsolute: () => '2026-07-22 10:00',
}));

vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), warning: vi.fn() },
}));

import { MessageActionBar } from '../MessageActionBar';

describe('MessageActionBar more menu', () => {
  const writeText = vi.fn(async () => undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
  });

  it('groups continue, add-to-chat, link copy, rewind, and delete under ellipsis', async () => {
    const onFork = vi.fn(async () => undefined);
    const onAddToChat = vi.fn();
    const onRewind = vi.fn();
    const onDelete = vi.fn(async () => undefined);
    const deepLink = 'cindy://session/session-a?message=message-a';

    render(
      <MessageActionBar
        copyText="message body"
        copyLinkText={deepLink}
        align="right"
        hovered
        onFork={onFork}
        onAddToChat={onAddToChat}
        onRewind={onRewind}
        onDelete={onDelete}
      />,
    );

    const trigger = screen.getByRole('button', {
      name: 'chat.messageActionBar.moreActions',
    });
    expect(trigger).toBeTruthy();
    expect(screen.queryByRole('button', {
      name: 'chat.messageActionBar.fork',
    })).toBeNull();
    expect(screen.queryByRole('button', {
      name: 'chat.messageActionBar.rewind',
    })).toBeNull();
    expect(screen.queryByRole('menuitem', {
      name: 'chat.messageActionBar.fork',
    })).toBeNull();

    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    expect(screen.getAllByRole('menuitem', {
      name: 'chat.messageActionBar.fork',
    })).toHaveLength(1);
    expect(screen.getByRole('menuitem', {
      name: 'chat.messageActionBar.fork',
    }).querySelector('.lucide-split')).toBeTruthy();
    expect(screen.getByRole('menuitem', {
      name: 'chat.quote.addToChat',
    }).querySelector('.lucide-message-square-plus')).toBeTruthy();
    expect(screen.getByRole('menuitem', {
      name: 'chat.messageActionBar.copyLink',
    }).querySelector('.lucide-link2')).toBeTruthy();
    expect(screen.getByRole('menuitem', {
      name: 'chat.messageActionBar.rewind',
    }).querySelector('.lucide-undo2')).toBeTruthy();
    expect(screen.getByRole('menuitem', {
      name: 'chat.messageActionBar.delete',
    }).querySelector('.lucide-trash2')).toBeTruthy();

    fireEvent.click(
      screen.getByRole('menuitem', {
        name: 'chat.messageActionBar.fork',
      }),
    );
    await waitFor(() => expect(onFork).toHaveBeenCalledTimes(1));

    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(
      screen.getByRole('menuitem', {
        name: 'chat.quote.addToChat',
      }),
    );
    expect(onAddToChat).toHaveBeenCalledTimes(1);

    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(
      screen.getByRole('menuitem', {
        name: 'chat.messageActionBar.copyLink',
      }),
    );
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(deepLink));

    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(
      screen.getByRole('menuitem', {
        name: 'chat.messageActionBar.rewind',
      }),
    );
    expect(onRewind).toHaveBeenCalledTimes(1);

    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(
      screen.getByRole('menuitem', {
        name: 'chat.messageActionBar.delete',
      }),
    );
    await waitFor(() => expect(onDelete).toHaveBeenCalledTimes(1));
  });

  it('does not restore pointer focus to the ellipsis trigger after close', async () => {
    render(
      <MessageActionBar
        copyText="message body"
        align="left"
        hovered
        onAddToChat={vi.fn()}
      />,
    );

    const trigger = screen.getByRole('button', {
      name: 'chat.messageActionBar.moreActions',
    });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(
      screen.getByRole('menuitem', {
        name: 'chat.quote.addToChat',
      }),
    );

    await waitFor(() => expect(document.activeElement).not.toBe(trigger));
  });

  it('restores focus to the ellipsis trigger for keyboard users', async () => {
    render(
      <MessageActionBar
        copyText="message body"
        align="left"
        hovered
        onAddToChat={vi.fn()}
      />,
    );

    const trigger = screen.getByRole('button', {
      name: 'chat.messageActionBar.moreActions',
    });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    const item = await screen.findByRole('menuitem', {
      name: 'chat.quote.addToChat',
    });
    fireEvent.keyDown(item, { key: 'Escape' });

    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});
