import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { BitesConfig } from "./config.js";

export const DEFAULT_AUTO_COMPACTION_THRESHOLD = 150_000;

export default function registerAutoCompaction(
  pi: ExtensionAPI,
  configRef: { current: BitesConfig },
): void {
  let compactionPending = false;

  pi.on("agent_settled", (_event, ctx) => {
    const threshold =
      configRef.current.autoCompaction?.thresholdTokens ?? DEFAULT_AUTO_COMPACTION_THRESHOLD;
    const tokens = ctx.getContextUsage()?.tokens;
    if (compactionPending || tokens == null || tokens < threshold) return;

    compactionPending = true;
    if (ctx.hasUI) ctx.ui.notify(`Compacting at ${tokens.toLocaleString()} tokens`, "info");
    ctx.compact({
      onComplete: () => {
        compactionPending = false;
      },
      onError: (error) => {
        compactionPending = false;
        if (ctx.hasUI) ctx.ui.notify(`Compaction failed: ${error.message}`, "error");
      },
    });
  });
}
