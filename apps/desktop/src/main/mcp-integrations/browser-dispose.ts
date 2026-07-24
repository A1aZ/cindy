// Electron-free core of the browser runtime's quit-time cleanup, split out so it
// is unit-testable without importing electron (browser.ts pulls in `app` via
// browser-runtime-env). browser.ts wires the real singleton runtime + logger into
// `stopRuntimeForQuit`; tests inject fakes. (Same pattern as the electron-free
// `extractBrowserAvailability` split.)
import type { BrowserControlRuntime } from '@cindy/browser-control-runtime';

/** Minimal logger surface used here — matches the unified logger's `warn`. */
interface QuitLogger {
  warn(message: string, ...args: unknown[]): void;
}

/**
 * Stop the managed browser on the app-quit path.
 *
 * Swallows/logs all failures: this runs inside the lifecycle disposer chain
 * where throwing would only stall shutdown, and a failed stop is recovered by
 * the vendored stale-lock path on next launch. `stop` is idempotent — a no-op if
 * the browser was never started.
 *
 * An unprofiled `stop` resolves the DEFAULT profile, which is sufficient because
 * the runtime is configured with exactly one managed profile (the sync.mjs patch
 * skips upstream's auto openclaw/user profiles, and an unknown profile name can't
 * launch). If multiple managed profiles are ever introduced, switch this to an
 * enumerate-and-stop so no launched Chrome leaks on quit.
 */
export async function stopRuntimeForQuit(
  runtime: Pick<BrowserControlRuntime, 'call'>,
  logger: QuitLogger,
): Promise<void> {
  try {
    const res = await runtime.call({ action: 'stop' });
    if (!res.ok) {
      logger.warn('browser runtime stop returned not-ok', {
        errorCode: res.errorCode,
        message: res.message,
      });
    }
  } catch (err) {
    logger.warn('browser runtime stop threw (ignored on quit path)', err);
  }
}
