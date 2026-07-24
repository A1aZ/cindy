import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const read = (relativePath: string): string =>
  readFileSync(resolve(__dirname, '..', relativePath), 'utf8').replace(/\r\n/g, '\n');

describe('remote Orca Worker creation context', () => {
  it('scopes capabilities, providers, and the nested model selector to the controlled device', () => {
    const popover = read('features/cc-agent/CreateWorkerPopover.tsx');

    expect(popover).toContain("useAgentCapabilities('claude-code', deviceId)");
    expect(popover).toContain("useAgentCapabilities('codex', deviceId)");
    expect(popover).toContain('useDeviceProviders(deviceId)');
    expect(popover).toContain('deviceId={deviceId}');
  });

  it('passes the same device context through both Worker creation entry points', () => {
    const sessionView = read('features/cc-agent/CCAgentSessionView.tsx');
    const workerPanel = read('features/cc-agent/OrcaWorkerPanel.tsx');
    const workersPlugin = read('features/right-sidebar/plugins/orca-workers/index.tsx');

    expect(sessionView).toContain('deviceId={remoteDeviceId}');
    expect(workerPanel).toContain('deviceId={deviceId}');
    expect(workersPlugin).toContain('deviceId={leadSession?.deviceLinkDeviceId}');
  });

  it('never uses the controller API key to gate a remote model row', () => {
    const selector = read('components/new-chat/ModelSelector.tsx');

    expect(selector).toContain("if (!deviceId) return id.startsWith('codex/') && !hasSavedKey;");
    expect(selector).toContain('if (remoteProviders.error) return false;');
    expect(selector).toContain('const rowAgentKind = resolveVisibleModelAgentKind({');
    expect(selector).toContain('providerOffersModel(provider, id, rowAgentKind)');
  });
});
