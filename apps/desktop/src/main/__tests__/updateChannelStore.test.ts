import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const appGetPath = vi.fn();

vi.mock('electron', () => ({
  app: {
    getPath: appGetPath,
  },
}));

vi.mock('../maker-host/logger-adapter.js', () => ({
  desktopMakerLogger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
    }),
  },
}));

let tempDir: string;

async function loadStore() {
  vi.resetModules();
  return import('../updateChannelStore');
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-update-channel-'));
  appGetPath.mockImplementation((name: string) => {
    if (name === 'userData') return tempDir;
    return tempDir;
  });
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('tryEnableUncustomizedBeta', () => {
  it('turns beta on via org default without writing a user enableBeta override', async () => {
    const store = await loadStore();

    expect(store.readUpdateChannelSettingsState()).toMatchObject({
      value: { enableBeta: false, orgDefaultEnableBeta: false },
      customizedKeys: [],
    });
    expect(store.tryEnableUncustomizedBeta()).toBe(true);
    expect(store.readUpdateChannelSettings()).toEqual({
      enableBeta: true,
      orgDefaultEnableBeta: true,
    });
    expect(store.isEnableBetaUserCustomized()).toBe(false);
    expect(store.readUpdateChannelSettingsState().customizedKeys).toEqual(['orgDefaultEnableBeta']);
  });

  it('does not reopen beta after the user turned it off', async () => {
    const store = await loadStore();
    store.writeEnableBeta(true);
    store.writeEnableBeta(false);

    expect(store.readUpdateChannelSettings()).toMatchObject({ enableBeta: false });
    expect(store.isEnableBetaUserCustomized()).toBe(true);
    expect(store.tryEnableUncustomizedBeta()).toBe(false);
    expect(store.readUpdateChannelSettings().enableBeta).toBe(false);
  });

  it('keeps a never-enabled opt-out as a user choice', async () => {
    const store = await loadStore();
    store.writeEnableBeta(false);

    expect(store.isEnableBetaUserCustomized()).toBe(true);
    expect(store.tryEnableUncustomizedBeta()).toBe(false);
    expect(store.readUpdateChannelSettings().enableBeta).toBe(false);
  });

  it('is a no-op when beta is already on', async () => {
    const store = await loadStore();
    store.writeEnableBeta(true);

    expect(store.tryEnableUncustomizedBeta()).toBe(false);
    expect(store.readUpdateChannelSettings().enableBeta).toBe(true);
    expect(store.isEnableBetaUserCustomized()).toBe(true);
  });
});
