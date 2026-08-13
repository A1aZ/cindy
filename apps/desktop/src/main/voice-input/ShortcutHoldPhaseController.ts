export type ShortcutHoldPhase = 'tap' | 'start' | 'end';

export interface ShortcutHoldPhaseControllerOptions {
  holdDelayMs?: number;
  onTrigger: (phase: ShortcutHoldPhase) => void;
}

const DEFAULT_HOLD_DELAY_MS = 450;

/**
 * Turns a native key-down/key-up stream into Cindy's short-tap / push-to-talk phases.
 *
 * Native helpers deliberately stay timing-free. Keeping the threshold here gives
 * macOS and Windows one tested product state machine and makes repeated key-down
 * messages harmless.
 */
export class ShortcutHoldPhaseController {
  private readonly holdDelayMs: number;
  private down = false;
  private holdThresholdReached = false;
  private holdTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: ShortcutHoldPhaseControllerOptions) {
    this.holdDelayMs = options.holdDelayMs ?? DEFAULT_HOLD_DELAY_MS;
  }

  setPressed(pressed: boolean): void {
    if (pressed === this.down) return;
    if (pressed) {
      this.down = true;
      this.holdThresholdReached = false;
      this.options.onTrigger('start');
      this.holdTimer = setTimeout(() => {
        this.holdTimer = null;
        if (this.down) this.holdThresholdReached = true;
      }, this.holdDelayMs);
      return;
    }

    const shouldTap = !this.holdThresholdReached;
    this.clearHoldTimer();
    this.down = false;
    this.holdThresholdReached = false;
    this.options.onTrigger(shouldTap ? 'tap' : 'end');
  }

  releaseIfPressed(): void {
    if (!this.down) return;
    this.clearHoldTimer();
    this.down = false;
    this.holdThresholdReached = false;
    this.options.onTrigger('end');
  }

  reset(): void {
    this.clearHoldTimer();
    this.down = false;
    this.holdThresholdReached = false;
  }

  private clearHoldTimer(): void {
    if (!this.holdTimer) return;
    clearTimeout(this.holdTimer);
    this.holdTimer = null;
  }
}
