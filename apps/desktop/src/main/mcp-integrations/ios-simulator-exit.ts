type IOSSimulatorExitAbortHandler = () => void;

let exitAbortHandler: IOSSimulatorExitAbortHandler | null = null;

export function registerIOSSimulatorExitAbortHandler(
  handler: IOSSimulatorExitAbortHandler,
): () => void {
  exitAbortHandler = handler;
  return () => {
    if (exitAbortHandler === handler) exitAbortHandler = null;
  };
}

/** Lightweight updater seam: never imports the simulator or media runtime. */
export function abortIOSSimulatorOperationsForExit(): void {
  try {
    exitAbortHandler?.();
  } catch {
    // A forced updater exit must not be blocked by best-effort child cleanup.
  }
}
