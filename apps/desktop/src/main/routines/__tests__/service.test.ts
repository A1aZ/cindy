import { afterEach, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({
  scope: 'owner-a',
  boundaryPending: false,
  load: vi.fn(async () => null),
  save: vi.fn(async () => {}),
  getBot: vi.fn(async () => ({ status: 'active', canonicalSessionId: 'canonical-task' })),
  storage: {
    get: vi.fn(async () => undefined),
    insert: vi.fn(async () => {}),
    update: vi.fn(async () => {}),
    listRuns: vi.fn(async () => [
      { id: 'execution', status: 'success', resultText: 'Reviewed PR' },
    ]),
  },
  scheduler: {
    runNow: vi.fn(async () => ({ runId: 'execution' })),
    pause: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
  },
}));
vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => mock.scope,
  getActiveAppSession: () => ({ dataOwnerId: mock.scope }),
  isAppSessionBoundaryPending: () => mock.boundaryPending,
  ownerScopedUserDataPath: () => '/mock/account/routines',
}));
vi.mock('../../device-link/broadcast-tap.js', () => ({
  tapWindowBroadcast: vi.fn(),
  getSafeDataOwnerPushStamp: vi.fn(),
}));
vi.mock('electron', () => ({
  app: { isPackaged: true },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: vi.fn() },
}));
vi.mock('../../security/trustedAppRenderer.js', () => ({ assertTrustedAppRendererEvent: vi.fn() }));
vi.mock('../../utils/ipcValidate.js', () => ({ throwIpcError: vi.fn() }));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ warn: vi.fn() }) }));
vi.mock('../../localDb/ipc/bots.js', () => ({ getBotRemoteResourceSource: mock.getBot }));
vi.mock('../../scheduler-host/index.js', () => ({
  getScheduler: () => mock.scheduler,
  getScheduleStorage: () => mock.storage,
}));
vi.mock('../store.js', () => ({
  RoutineFileStore: class {
    load = mock.load;
    save = mock.save;
  },
}));
import { getRoutineEngine, routineTools, stopRoutines } from '../service.js';
afterEach(async () => {
  await stopRoutines();
  vi.clearAllMocks();
  mock.scope = 'owner-a';
  mock.boundaryPending = false;
  vi.useRealTimers();
});
it('dispatches into the current canonical task through the existing silent runner', async () => {
  const routine = await routineTools.save('bot', {
    name: 'Review',
    prompt: 'Check the PR',
    enabled: true,
    triggers: [{ id: 'tick', kind: 'interval', intervalMs: 60000 }],
  });
  await routineTools.runNow('bot', routine.id);
  await vi.waitFor(async () =>
    expect((await routineTools.history('bot', routine.id))[0].status).toBe('success'),
  );
  expect(mock.storage.insert).toHaveBeenCalledWith(
    expect.objectContaining({
      source: 'bot',
      targetSessionId: 'canonical-task',
      manual: true,
      silentWhenIdle: true,
      prompt: expect.stringContaining('Check the PR'),
    }),
  );
  expect((await routineTools.history('bot', routine.id))[0].resultText).toBe('Reviewed PR');
});
it('invalidates an in-progress startup before reset completes', async () => {
  let release!: () => void;
  mock.load.mockImplementationOnce(
    () =>
      new Promise<null>((resolve) => {
        release = () => resolve(null);
      }),
  );
  const pending = getRoutineEngine();
  const rejected = expect(pending).rejects.toThrow('reset');
  const stopping = stopRoutines();
  release();
  await rejected;
  await stopping;
  expect(mock.scheduler.runNow).not.toHaveBeenCalled();
});

it('restarts after a cancelled account transition instead of returning a stopped engine', async () => {
  vi.useFakeTimers();
  const first = await getRoutineEngine();
  mock.boundaryPending = true;
  await vi.advanceTimersByTimeAsync(1000);
  mock.boundaryPending = false;
  expect(await getRoutineEngine()).not.toBe(first);
});
