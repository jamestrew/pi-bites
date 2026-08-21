import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BitesConfig } from "./config.js";

export const DEFAULT_AUTO_COMPACTION_THRESHOLD = 150_000;

export default function registerAutoCompaction(
  pi: ExtensionAPI,
  configRef: { current: BitesConfig },
): void {
  let compactionPending = false;

  const compactAtThreshold = (ctx: ExtensionContext, resume: boolean) => {
    const threshold =
      configRef.current.autoCompaction?.thresholdTokens ?? DEFAULT_AUTO_COMPACTION_THRESHOLD;
    const tokens = ctx.getContextUsage()?.tokens;
    if (compactionPending || tokens == null || tokens < threshold) return;

    compactionPending = true;
    const ui = ctx.hasUI ? ctx.ui : undefined;
    ui?.notify(`Compacting at ${tokens.toLocaleString()} tokens`, "info");
    ctx.compact({
      onComplete: () => {
        compactionPending = false;
        if (resume) {
          pi.sendMessage(
            {
              customType: "auto-compaction-continuation",
              content: "Continue the previous task after compaction.",
              display: false,
            },
            { triggerTurn: true, deliverAs: "followUp" },
          );
        }
      },
      onError: (error) => {
        compactionPending = false;
        ui?.notify(`Compaction failed: ${error.message}`, "error");
      },
    });
  };

  pi.on("turn_end", (event, ctx) => {
    const resume =
      ctx.hasPendingMessages() ||
      (event.message.role === "assistant" &&
        event.message.content.some((block) => block.type === "toolCall"));
    compactAtThreshold(ctx, resume);
  });
  pi.on("agent_settled", (_event, ctx) => compactAtThreshold(ctx, false));
}
