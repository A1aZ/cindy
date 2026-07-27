import type { IOSSimulatorFocusRequest } from '../../../../shared/iosSimulatorIpc';

import { createLogger } from '@/lib/logger';
import { isSecondaryWindow } from '@/lib/secondaryWindow';
import { addTab, ensureHydrated, getBucket, patchTabState, setActiveTab } from '../store';
import { requestRightSidebarVisibility } from './sidebarCommands';

const log = createLogger('rightSidebar.iosSimulatorFocus');

let initialized = false;
let teardown: (() => void) | null = null;
let operationTail: Promise<void> = Promise.resolve();

async function focusSimulator(request: IOSSimulatorFocusRequest): Promise<void> {
  const sessionId = request.sessionId.trim();
  const instanceId = request.instanceId.trim();
  if (!sessionId || !instanceId) return;

  await ensureHydrated(sessionId);
  const bucket = getBucket(sessionId);
  const exact = bucket.tabs.find(
    (tab) =>
      tab.kind === 'ios-simulator' &&
      (tab.state as { instanceId?: unknown } | null)?.instanceId === instanceId,
  );
  const existing = exact ?? bucket.tabs.find((tab) => tab.kind === 'ios-simulator');
  if (existing) {
    if (!exact) {
      await patchTabState(sessionId, existing.id, () => ({ instanceId }));
    }
    await setActiveTab(sessionId, existing.id);
  } else {
    await addTab(sessionId, 'ios-simulator', { instanceId });
  }
  requestRightSidebarVisibility('open', { sessionId });
}

/** Main-to-renderer bridge that reveals an exact simulator after it becomes viewable. */
export function initIOSSimulatorFocusBridge(): () => void {
  if (initialized) return teardown ?? (() => undefined);
  initialized = true;
  if (isSecondaryWindow() || !window.electronAPI?.maker?.iosSimulator?.onFocusRequest) {
    teardown = () => undefined;
    return teardown;
  }
  teardown = window.electronAPI.maker.iosSimulator.onFocusRequest((request) => {
    operationTail = operationTail
      .catch(() => undefined)
      .then(() => focusSimulator(request))
      .catch((error) => {
        log.warn('Unable to focus the iOS Simulator pane', error);
      });
  });
  return teardown;
}

export function _resetIOSSimulatorFocusBridgeForTests(): void {
  teardown?.();
  initialized = false;
  teardown = null;
  operationTail = Promise.resolve();
}
