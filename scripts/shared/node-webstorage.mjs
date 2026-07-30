/**
 * Node 25 installs the WebStorage globals by default, and with no
 * `--localstorage-file` configured `globalThis.localStorage` is a stub whose
 * methods are all missing: under the node environment it fools a
 * `typeof localStorage !== 'undefined'` probe, and under jsdom the pre-existing
 * key displaces jsdom's working implementation, because Vitest skips populating
 * globals that already exist. `--no-experimental-webstorage` restores the
 * original semantics; on Node 22 (local dev and CI) the global never exists, so
 * the flag is a pure no-op there.
 *
 * That distinction decides how apps/desktop runs its unit tests, in two places
 * which have to agree: its Vitest config (does the worker pool need the flag)
 * and the root test-workspaces manifest (which pool the unit tier uses). The two
 * cannot be combined — passing custom execArgv to worker threads segfaults the
 * isolate during teardown. Measured 2026-07-30: 2 of 10 full desktop unit runs
 * crashed inside node::worker::WorkerThreadData::~WorkerThreadData -> final GC
 * -> GlobalHandles::InvokeFirstPassWeakCallbacks, i.e. a native addon finalizer
 * touching freed memory as the isolate went away; 8 further runs with the
 * execArgv removed produced none.
 *
 * So the flag and the threads pool are mutually exclusive, and this predicate
 * picks between them: where the flag is genuinely needed, keep today's
 * behaviour (forks, flag applied); where it is a no-op, drop it and take threads
 * instead, which spawns no process per test file (see UNIT_POOL_DEFAULT in
 * scripts/test-workspaces.config.mjs).
 */
export function nodeWebstorageEnabled(globalObject = globalThis) {
  return typeof globalObject.localStorage !== 'undefined';
}
