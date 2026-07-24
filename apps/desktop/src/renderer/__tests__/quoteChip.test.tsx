// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { QuoteChip } from '@/components/chat/QuoteChip';

afterEach(() => {
  cleanup();
});

describe('QuoteChip', () => {
  it('collapses multiline quote text into a single-line summary', () => {
    const { container } = render(<QuoteChip quote={{ text: 'first line\n\nsecond line' }} />);

    const chip = container.querySelector<HTMLElement>('[aria-label]');
    expect(chip?.getAttribute('aria-label')).toBe('first line\n\nsecond line');
    expect(chip?.textContent).toBe('first line second line');
    expect(chip?.className).toContain('select-none');
  });

  it('uses the compact primary-text shell without a close button', () => {
    const { container } = render(<QuoteChip quote={{ text: 'quoted' }} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(
      container.querySelector('[data-inline-reference-chip]')?.className,
    ).toContain('text-[var(--text-primary)]');
  });
});
