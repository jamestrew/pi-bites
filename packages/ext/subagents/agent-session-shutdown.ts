import type { AgentSession, SessionShutdownEvent } from "@earendil-works/pi-coding-agent";

const shutdowns = new WeakMap<AgentSession, Promise<void>>();
const CANCELLED_BEFORE_PROMPT = "Subagent cancelled before prompt.";

export function assertAgentNotCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error(CANCELLED_BEFORE_PROMPT);
}

/** Notify child extensions exactly once, then invalidate and dispose the session. */
export function shutdownAgentSession(
  session: AgentSession,
  reason: SessionShutdownEvent["reason"] = "quit",
): Promise<void> {
  const existing = shutdowns.get(session);
  if (existing) return existing;

  // Defer emission until after the promise is registered so a shutdown handler
  // that re-enters this function observes the same in-flight teardown.
  const shutdown = Promise.resolve().then(async () => {
    try {
      await session.extensionRunner.emit({ type: "session_shutdown", reason });
    } catch {
      // Extension cleanup is best-effort; session disposal is not.
    } finally {
      session.dispose();
    }
  });
  shutdowns.set(session, shutdown);
  return shutdown;
}

export async function shutdownCancelledAgentSession(session: AgentSession): Promise<never> {
  await shutdownAgentSession(session);
  throw new Error(CANCELLED_BEFORE_PROMPT);
}

/** Bind child extensions, but let manager cancellation tear down stalled initialization. */
export async function bindAgentSessionExtensions(
  session: AgentSession,
  bindings: Parameters<AgentSession["bindExtensions"]>[0],
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) return shutdownCancelledAgentSession(session);
  if (!signal) {
    try {
      await session.bindExtensions(bindings);
    } catch (error) {
      await shutdownAgentSession(session);
      throw error;
    }
    return;
  }

  let onAbort: (() => void) | undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new Error(CANCELLED_BEFORE_PROMPT));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([session.bindExtensions(bindings), cancelled]);
    assertAgentNotCancelled(signal);
  } catch (error) {
    await shutdownAgentSession(session);
    if (signal.aborted) throw new Error(CANCELLED_BEFORE_PROMPT);
    throw error;
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}
