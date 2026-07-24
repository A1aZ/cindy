// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { EmptyState } from '../EmptyState';

afterEach(() => cleanup());

describe('EmptyState add-more hint', () => {
  it('renders a non-interactive hint for the existing top add button', () => {
    render(
      <EmptyState
        onAddFileTab={vi.fn()}
        onAddReviewTab={vi.fn()}
        onAddBrowserTab={vi.fn()}
        onAddTerminalTab={vi.fn()}
      />,
    );

    const hint = screen.getByText('rightSidebar.tabs.empty.addMoreHint');
    expect(hint.tagName).toBe('P');
    expect(hint.closest('button')).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'rightSidebar.tabs.empty.addMoreHint' }),
    ).toBeNull();
  });
});
