// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { File } from 'lucide-react';
import { afterEach, describe, expect, it } from 'vitest';

import { InlineReferenceChip } from '@/components/chat/InlineReferenceChip';

afterEach(cleanup);

describe('InlineReferenceChip', () => {
  it('keeps one compact pill geometry with primary text and no close action', () => {
    const { container } = render(
      <InlineReferenceChip
        label="src/very-long-file-name.ts"
        icon={<File />}
      />,
    );
    const chip = container.querySelector('[data-inline-reference-chip]');
    expect(chip?.className).toContain('rounded-full');
    expect(chip?.className).toContain('gap-1.5');
    expect(chip?.className).toContain('text-[12px]');
    expect(chip?.className).toContain('px-2');
    expect(chip?.className).toContain('text-[var(--text-primary)]');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('renders sent/static chips without remove or drag controls', () => {
    const { container } = render(<InlineReferenceChip label="Static reference" />);
    const chip = container.querySelector('[data-inline-reference-chip]');
    expect(chip?.className).toContain('px-2');
    expect(screen.queryByRole('button')).toBeNull();
    expect(chip?.getAttribute('draggable')).toBeNull();
    expect(chip?.getAttribute('title')).toBeNull();
  });
});
