import { useEffect, useState } from 'react';
import type { ScheduleTemplate, TemplateCategory } from '@cindy/maker-scheduler';
import { TEMPLATE_CATEGORIES } from '@cindy/maker-scheduler/templates';

interface UseTemplatesResult {
  templates: ScheduleTemplate[];
  categories: TemplateCategory[];
  loading: boolean;
  error: string | null;
}

export function useTemplates(): UseTemplatesResult {
  const [templates, setTemplates] = useState<ScheduleTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = (await window.electronAPI.maker.schedule.listTemplates()) as ScheduleTemplate[];
        if (!cancelled) setTemplates(list);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return { templates, categories: TEMPLATE_CATEGORIES, loading, error };
}
