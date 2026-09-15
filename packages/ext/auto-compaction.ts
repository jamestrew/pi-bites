import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BitesConfig } from "./config.js";

export const DEFAULT_AUTO_COMPACTION_THRESHOLD = 150_000;

type AutoCompactingSession = {
  _runAutoCompaction?(reason: "threshold", willRetry: false): Promise<boolean>;
};

/**
 * Use Pi's automatic compaction path while the current agent loop is already
 * paused between turns. Unlike ctx.compact(), this does not abort the run.
 */
export function installTurnBoundaryAutoCompaction(
  session: AgentSession,
  thresholdTokens: number,
): void {
  const previousPrepare = session.agent.prepareNextTurnWithContext;
  session.agent.prepareNextTurnWithContext = async (turn, signal) => {
    const snapshot = await previousPrepare?.(turn, signal);
    const tokens = session.getContextUsage()?.tokens;
    if (signal?.aborted || tokens == null || tokens < thresholdTokens) return snapshot;
    const autoSession = session as unknown as AutoCompactingSession;
    if (!autoSession._runAutoCompaction) return snapshot;

    const abortCompaction = () => session.abortCompaction();
    // _runAutoCompaction creates its abort controller only after async auth.
    // If cancellation lands during auth, retry the abort immediately after the
    // controller is announced so no summarization outlives the owning run.
    const stopWatching = signal
      ? session.subscribe((event) => {
          if (event.type === "compaction_start" && signal.aborted) queueMicrotask(abortCompaction);
        })
      : undefined;
    signal?.addEventListener("abort", abortCompaction, { once: true });
    try {
      await autoSession._runAutoCompaction("threshold", false);
    } catch {
      // This is a private Pi seam. Preserve the active invocation if an
      // incompatible upstream implementation rejects; continue uncompacted.
      return snapshot;
    } finally {
      signal?.removeEventListener("abort", abortCompaction);
      stopWatching?.();
    }
    const context = snapshot?.context ?? turn.context;
    return {
      ...snapshot,
      context: { ...context, messages: session.agent.state.messages.slice() },
    };
  };
}

export default function registerAutoCompaction(
  pi: ExtensionAPI,
  configRef: { current: BitesConfig },
): void {
  let compactionPending = false;
  let resumeAfterCompaction = false;

  const tokensAtThreshold = (ctx: ExtensionContext): number | undefined => {
    if (ctx.mode === "print" || ctx.mode === "json") return;
    const threshold =
      configRef.current.autoCompaction?.thresholdTokens ?? DEFAULT_AUTO_COMPACTION_THRESHOLD;
    const tokens = ctx.getContextUsage()?.tokens;
    return tokens != null && tokens >= threshold ? tokens : undefined;
  };

  const reset = () => {
    resumeAfterCompaction = false;
  };
  pi.on("session_start", reset);
  pi.on("session_tree", reset);

  pi.on("turn_end", (event, ctx) => {
    if (
      resumeAfterCompaction ||
      ctx.signal?.aborted ||
      ctx.hasPendingMessages() ||
      tokensAtThreshold(ctx) === undefined ||
      event.message.role !== "assistant" ||
      !event.message.content.some((block) => block.type === "toolCall")
    ) {
      return;
    }

    // End the run cleanly before manual compaction; ctx.compact() aborts an
    // active run and races with tools such as Code Mode's exec invocation.
    resumeAfterCompaction = true;
    ctx.abort();
  });

  pi.on("agent_settled", (_event, ctx) => {
    const tokens = tokensAtThreshold(ctx);
    if (compactionPending || tokens === undefined) return;

    compactionPending = true;
    const resume = resumeAfterCompaction;
    resumeAfterCompaction = false;
    const ui = ctx.hasUI ? ctx.ui : undefined;
    ui?.notify(`Compacting at ${tokens.toLocaleString()} tokens`, "info");
    const finish = () => {
      compactionPending = false;
      if (resume) {
        try {
          pi.sendMessage(
            {
              customType: "auto-compaction-continuation",
              content: "Continue the previous task after compaction.",
              display: false,
            },
            { triggerTurn: true, deliverAs: "followUp" },
          );
        } catch {
          // Session replacement invalidates the old extension API; the new
          // session owns any continuation from that point onward.
        }
      }
    };
    ctx.compact({
      onComplete: finish,
      onError: (error) => {
        ui?.notify(`Compaction failed: ${error.message}`, "error");
        finish();
      },
    });
  });
}
