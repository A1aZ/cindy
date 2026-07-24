import { beforeEach, describe, expect, it, vi } from 'vitest';

class MemLocalStorage {
  private store = new Map<string, string>();

  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) as string) : null;
  }

  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }
}

let memStorage: MemLocalStorage;

beforeEach(() => {
  memStorage = new MemLocalStorage();
  vi.stubGlobal('window', { localStorage: memStorage });
  vi.stubGlobal('localStorage', memStorage);
  vi.resetModules();
});

async function loadModule() {
  return await import('@/state/newMakerDraft');
}

describe('newMakerDraft remote host identity', () => {
  it('preserves remoteHostId across storage reload when workingDir exists', async () => {
    const m1 = await loadModule();
    m1.patchDraft({ workingDir: '/srv/app', remoteHostId: 'remote-host-a' });
    expect(m1.getDraft().remoteHostId).toBe('remote-host-a');

    vi.resetModules();
    const m2 = await loadModule();
    expect(m2.getDraft().workingDir).toBe('/srv/app');
    expect(m2.getDraft().remoteHostId).toBe('remote-host-a');
  });

  it('clears remoteHostId when switching to a local project or dialogue', async () => {
    const { getDraft, patchDraft } = await loadModule();
    patchDraft({ workingDir: '/srv/app', remoteHostId: 'remote-host-a' });
    patchDraft({ workingDir: '/local/app' });
    expect(getDraft().workingDir).toBe('/local/app');
    expect(getDraft().remoteHostId).toBeNull();

    patchDraft({ workingDir: '/srv/app', remoteHostId: 'remote-host-a' });
    patchDraft({ workingDir: null });
    expect(getDraft().workingDir).toBeNull();
    expect(getDraft().remoteHostId).toBeNull();
  });

  it('forces collab off for remote project drafts (no local worker on remote path)', async () => {
    const { getDraft, patchDraft, patchCollab } = await loadModule();
    // 本地项目可以开协同
    patchDraft({ workingDir: '/local/app', collab: { enabled: true, worker: 'codex' } });
    expect(getDraft().collab.enabled).toBe(true);

    // 切到 remote 项目 → 协同被强制关闭
    patchDraft({ workingDir: '/srv/app', remoteHostId: 'remote-host-a' });
    expect(getDraft().remoteHostId).toBe('remote-host-a');
    expect(getDraft().collab.enabled).toBe(false);

    // remote draft 下尝试开启协同也无效(store 兜底)
    patchCollab({ enabled: true });
    expect(getDraft().collab.enabled).toBe(false);
  });

  it('drops collab on reload when a persisted draft is remote', async () => {
    memStorage.setItem(
      'xdt:newMakerDraft:v1',
      JSON.stringify({
        vendor: 'cc',
        workingDir: '/srv/app',
        remoteHostId: 'remote-host-a',
        collab: { enabled: true, worker: 'codex' },
      }),
    );
    vi.resetModules();
    const { getDraft } = await loadModule();
    expect(getDraft().remoteHostId).toBe('remote-host-a');
    expect(getDraft().collab.enabled).toBe(false);
  });

  it('keeps legacy draft storage without remoteHostId as local', async () => {
    memStorage.setItem(
      'xdt:newMakerDraft:v1',
      JSON.stringify({
        vendor: 'cc',
        workingDir: '/legacy/app',
      }),
    );
    vi.resetModules();
    const { getDraft } = await loadModule();
    expect(getDraft().workingDir).toBe('/legacy/app');
    expect(getDraft().remoteHostId).toBeNull();
  });
});
