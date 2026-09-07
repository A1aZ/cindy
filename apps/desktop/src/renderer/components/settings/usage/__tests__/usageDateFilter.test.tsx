// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { UsageDateFilter } from '../UsageDateFilter';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
afterEach(cleanup);

describe('UsageDateFilter', () => {
  it('applies complete dates explicitly, including old and zero-usage days', () => {
    const onSelectDay = vi.fn();
    const { getByLabelText, getByRole } = render(
      <UsageDateFilter selectedDay={null} todayKey="2026-09-08" onSelectDay={onSelectDay} />,
    );
    const input = getByLabelText('usageHistory.date.label') as HTMLInputElement;
    expect(input.type).toBe('date');
    // No minimum date bound can exclude padded heatmap dates or older history.
    expect(input.min).toBe('');
    fireEvent.change(input, { target: { value: '2025-01-01' } });
    expect(onSelectDay).not.toHaveBeenCalled();
    fireEvent.click(getByRole('button', { name: 'usageHistory.date.apply' }));
    expect(onSelectDay).toHaveBeenLastCalledWith('2025-01-01');
    fireEvent.change(input, { target: { value: '2026-09-08' } });
    fireEvent.submit(input.closest('form')!);
    expect(onSelectDay).toHaveBeenLastCalledWith('2026-09-08');
  });

  it('does not submit empty, incomplete or future dates', () => {
    const onSelectDay = vi.fn();
    const { getByLabelText } = render(
      <UsageDateFilter selectedDay={null} todayKey="2026-09-08" onSelectDay={onSelectDay} />,
    );
    const input = getByLabelText('usageHistory.date.label') as HTMLInputElement;
    for (const value of ['', '2026-02-30', '2026-09-09']) {
      fireEvent.change(input, { target: { value } });
      fireEvent.submit(input.closest('form')!);
    }
    expect(onSelectDay).not.toHaveBeenCalled();
  });

  it('tracks chart selection and clears when a relative preset replaces it', () => {
    const onSelectDay = vi.fn();
    const view = render(
      <UsageDateFilter selectedDay="2026-09-07" todayKey="2026-09-08" onSelectDay={onSelectDay} />,
    );
    const input = view.getByLabelText('usageHistory.date.label') as HTMLInputElement;
    expect(input.value).toBe('2026-09-07');
    view.rerender(
      <UsageDateFilter selectedDay="2026-09-08" todayKey="2026-09-08" onSelectDay={onSelectDay} />,
    );
    expect(input.value).toBe('2026-09-08');
    view.rerender(
      <UsageDateFilter selectedDay={null} todayKey="2026-09-08" onSelectDay={onSelectDay} />,
    );
    expect(input.value).toBe('');
    expect(onSelectDay).not.toHaveBeenCalled();
  });
});
