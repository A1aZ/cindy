import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import type { ScanResultPayload } from '../PublishDialog';

interface RejectionFeedbackTarget {
  entryKey: string | null;
  name: string | null;
  version: string | null;
  canManage: boolean;
}

/** User-requested feedback is scoped separately from automatic publication results. */
export function useRejectionFeedback({ entryKey, name, version, canManage }: RejectionFeedbackTarget) {
  const owner = getDataOwnerGeneration();
  const scope = useMemo(() => ({ entryKey, name, version, canManage, owner }),
    [entryKey, name, version, canManage, owner]);
  const requestId = useRef(0);
  const [feedback, setFeedback] = useState<{ scope: typeof scope; result: ScanResultPayload } | null>(null);

  useEffect(() => () => { requestId.current += 1; }, [scope]);

  const dismiss = useCallback(() => {
    requestId.current += 1;
    setFeedback(null);
  }, []);

  const open = useCallback(async () => {
    if (!scope.name || !scope.version || !scope.canManage || !isDataOwnerGenerationCurrent(scope.owner)) return;
    const id = ++requestId.current;
    // Publishing targets the native Hub even when the local copy came from a team catalog.
    const response = await window.electronAPI.skillhub.getScanStatus({
      slug: scope.name, version: scope.version,
    }).catch(() => null);
    if (id !== requestId.current || !isDataOwnerGenerationCurrent(scope.owner)) return;
    setFeedback({
      scope,
      result: response?.success
        ? { status: response.status, gates: response.gates as ScanResultPayload['gates'], rejectionReason: response.rejectionReason }
        : { status: 'rejected', gates: [] },
    });
  }, [scope]);

  // Hide previous feedback during render, before effect cleanup can run.
  const result = feedback?.scope === scope && isDataOwnerGenerationCurrent(scope.owner)
    ? feedback.result : null;
  return { result, open, dismiss };
}
