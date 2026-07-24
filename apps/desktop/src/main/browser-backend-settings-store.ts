/**
 * browser-backend-settings-store — controls which backend the MCP `browser`
 * tool drives (Phase 5).
 *
 * File: <userData>/browser-backend-settings.json
 *
 * Defaults: `kind: 'rsb-webview'`. The internal sidebar browser is the new
 * product default — users who installed before Phase 5 see a behavioral
 * change on first launch. Switching to `'external'` restores the old managed
 * Chrome behavior verbatim (backend wraps the unchanged vendored runtime).
 *
 * Stored as a single field so future Phase 5+ knobs (e.g. snapshot format
 * preference) can join the same file under override-settings-file semantics
 * (rule 20: system default vs. user override is preserved, "reset" clears the
 * override rather than overwriting with a frozen snapshot).
 */

import { app } from 'electron';
import path from 'node:path';

import { desktopMakerLogger } from './maker-host/logger-adapter.js';
import {
  createOverrideSettingsFile,
  type OverrideSettingsState,
} from './maker-host/override-settings-file.js';
import type { BackendKind } from './mcp-integrations/browser-backend/index.js';

const log = desktopMakerLogger.child('browser-backend-settings-store');

export interface BrowserBackendSettings {
  kind: BackendKind;
}

const DEFAULTS: BrowserBackendSettings = {
  kind: 'rsb-webview',
};

const VALID_KINDS: readonly BackendKind[] = ['external', 'rsb-webview'];

function settingsFilePath(): string {
  return path.join(app.getPath('userData'), 'browser-backend-settings.json');
}

function normalize(raw: unknown): BrowserBackendSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  const kind =
    typeof r.kind === 'string' && (VALID_KINDS as string[]).includes(r.kind)
      ? (r.kind as BackendKind)
      : DEFAULTS.kind;
  return { kind };
}

const store = createOverrideSettingsFile<BrowserBackendSettings>({
  filePath: settingsFilePath,
  defaults: DEFAULTS,
  normalize,
  log,
  label: 'browser-backend',
});

export function readBrowserBackendSettings(): BrowserBackendSettings {
  return store.read();
}

export function readBrowserBackendSettingsState(): OverrideSettingsState<BrowserBackendSettings> {
  return store.readState();
}

export function writeBrowserBackendKind(kind: BackendKind): void {
  store.writePatch({ kind });
  log.info('browser-backend kind written', { kind });
}

/** Reset = clear user override, fall back to current system default. */
export function resetBrowserBackendSettings(): BrowserBackendSettings {
  return store.reset();
}

export const __testing = { normalize, DEFAULTS };
