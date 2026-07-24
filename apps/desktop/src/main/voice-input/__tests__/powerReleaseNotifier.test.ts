import { describe, expect, it, vi } from 'vitest';

import { VOICE_INPUT_POWER_STATE_CHANNEL } from '../../../shared/voiceInputPowerIpc';
import { installVoiceInputPowerRelease, type VoicePowerMonitorLike } from '../powerReleaseNotifier';

function createFakePowerMonitor(): VoicePowerMonitorLike & { emit: (event: string) => void } {
  const listeners = new Map<string, Array<() => void>>();
  return {
    on(event: string, listener: () => void) {
      const existing = listeners.get(event) ?? [];
      existing.push(listener);
      listeners.set(event, existing);
      return this;
    },
    emit(event: string) {
      (listeners.get(event) ?? []).forEach((listener) => listener());
    },
  } as VoicePowerMonitorLike & { emit: (event: string) => void };
}

describe('installVoiceInputPowerRelease', () => {
  it('broadcasts a release reason on suspend and lock-screen', () => {
    const powerMonitor = createFakePowerMonitor();
    const broadcast = vi.fn();

    installVoiceInputPowerRelease({
      powerMonitor,
      broadcast,
      logger: { debug: vi.fn() },
    });

    powerMonitor.emit('suspend');
    powerMonitor.emit('lock-screen');

    expect(broadcast).toHaveBeenNthCalledWith(1, VOICE_INPUT_POWER_STATE_CHANNEL, {
      reason: 'system_suspend',
    });
    expect(broadcast).toHaveBeenNthCalledWith(2, VOICE_INPUT_POWER_STATE_CHANNEL, {
      reason: 'screen_locked',
    });
  });

  it('does not broadcast before a power event fires', () => {
    const powerMonitor = createFakePowerMonitor();
    const broadcast = vi.fn();

    installVoiceInputPowerRelease({ powerMonitor, broadcast, logger: { debug: vi.fn() } });

    expect(broadcast).not.toHaveBeenCalled();
  });
});
