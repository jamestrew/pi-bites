export interface WaitableSession {
  exitCode: number | null | undefined;
  outputVersion: number;
  listeners: Set<() => void>;
}

export function registerAbortHandler(
  signal: AbortSignal | undefined,
  onAbort: () => void,
): () => void {
  if (!signal) return () => {};
  if (signal.aborted) {
    onAbort();
    return () => {};
  }
  const abortListener = () => onAbort();
  signal.addEventListener("abort", abortListener, { once: true });
  return () => signal.removeEventListener("abort", abortListener);
}

export function waitForExitOrDeadline(
  session: WaitableSession,
  waitMs: number,
  signal?: AbortSignal,
  onUpdate?: (elapsedMs: number) => void,
): Promise<number> {
  if (session.exitCode !== undefined && session.exitCode !== null) return Promise.resolve(0);
  if (signal?.aborted) return Promise.resolve(0);
  const startedAt = Date.now();
  return new Promise((resolve) => {
    let done = false;
    let abortCleanup: (() => void) | undefined;
    let updateTimer: ReturnType<typeof setInterval> | undefined;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (updateTimer) clearInterval(updateTimer);
      abortCleanup?.();
      session.listeners.delete(onWake);
      resolve(Date.now() - startedAt);
    };
    const onWake = () => {
      if (session.exitCode !== undefined && session.exitCode !== null) finish();
    };
    const timer = setTimeout(finish, waitMs);
    session.listeners.add(onWake);
    abortCleanup = registerAbortHandler(signal, finish);
    if (onUpdate) updateTimer = setInterval(() => onUpdate(Date.now() - startedAt), 250);
  });
}
