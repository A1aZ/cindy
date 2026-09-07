import React, { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/** Same-page equivalent entry for every selectable chart date (DESIGN §5). */
export function UsageDateFilter({
  selectedDay,
  todayKey,
  onSelectDay,
}: {
  selectedDay: string | null;
  todayKey: string;
  onSelectDay: (day: string) => void;
}): React.JSX.Element {
  const { t, i18n } = useTranslation();
  const inputId = useId();
  const [draftDay, setDraftDay] = useState(selectedDay ?? '');

  useEffect(() => {
    setDraftDay(selectedDay ?? '');
  }, [selectedDay]);

  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        // Native date validation rejects incomplete or future dates. Applying
        // explicitly keeps editing individual date segments from filtering.
        if (todayKey && event.currentTarget.reportValidity()) onSelectDay(draftDay);
      }}
    >
      <label htmlFor={inputId} className="text-12 font-medium text-[var(--text-secondary)]">
        {t('usageHistory.date.label')}
      </label>
      <Input
        id={inputId}
        type="date"
        size="md"
        className="w-[190px]"
        inputClassName="[color-scheme:light] dark:[color-scheme:dark]"
        lang={i18n.language}
        value={draftDay}
        onChange={setDraftDay}
        max={todayKey || undefined}
        required
        disabled={!todayKey}
      />
      <Button type="submit" variant="secondary" size="lg" disabled={!todayKey || !draftDay}>
        {t('usageHistory.date.apply')}
      </Button>
    </form>
  );
}
