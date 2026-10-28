import { getCurrentSystemMessage } from "@earendil-works/pi-ai";
import {
  estimateTokens,
  findCutPoint,
  generateSummaryWithUsage,
  SettingsManager,
  type BoundaryState,
  type BoundaryResult,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { BitesConfig } from "./config.js";

export const DEFAULT_AUTO_COMPACTION_THRESHOLD = 200_000;

export default function registerAutoCompaction(
  pi: ExtensionAPI,
  configRef: { current: BitesConfig },
): void {
  const compact = async (
    event: BoundaryState,
    ctx: ExtensionContext,
  ): Promise<BoundaryResult | undefined> => {
    const { model, modelRegistry, signal, thinkingLevel, sessionManager } = ctx;
    if (!model || signal?.aborted || event.outcome !== "completed") return;
    // Another handler already supplied a checkpoint for this boundary.
    if (event.entries.some((entry) => entry.type === "compaction")) return;
    const context = event.context;
    const usage = ctx.getContextUsage();
    const system = getCurrentSystemMessage(context.contextMessages);
    const estimated = () =>
      (system ? estimateTokens(system) : 0) +
      context.contextMessages.reduce(
        (sum, message) => sum + (message.role === "system" ? 0 : estimateTokens(message)),
        0,
      );
    const tokens = event.entries.length ? estimated() : (usage?.tokens ?? estimated());
    const threshold = Math.min(
      configRef.current.autoCompaction?.thresholdTokens ?? DEFAULT_AUTO_COMPACTION_THRESHOLD,
      Math.floor(model.contextWindow * 0.85),
    );
    if (tokens < threshold) return;

    const settings = SettingsManager.inMemory(pi.getSettings()).getCompactionSettings(model);
    const previous = context.contextEntries.find(
      (entry) => entry.sourceEntry.type === "compaction" && entry.messages.length > 0,
    )?.sourceEntry;
    const entries = context.contextEntries.flatMap(({ sourceEntry, messages }) =>
      sourceEntry.type === "compaction"
        ? []
        : messages
            .filter((message) => message.role !== "system")
            .map((message) => ({ ...sourceEntry, type: "message" as const, message })),
    );
    const cut = findCutPoint(entries, 0, entries.length, settings.keepRecentTokens);
    const firstKeptEntryId = entries[cut.firstKeptEntryIndex]?.id;
    // Proposed entries get new IDs at commit; wait for a stable retention anchor.
    if (
      !firstKeptEntryId ||
      cut.firstKeptEntryIndex === 0 ||
      !sessionManager.getEntry(firstKeptEntryId) ||
      (previous?.type === "compaction" && previous.firstKeptEntryId === firstKeptEntryId)
    )
      return;

    const ui = ctx.hasUI ? ctx.ui : undefined;
    try {
      const summary = await generateSummaryWithUsage(
        entries.slice(0, cut.firstKeptEntryIndex).map((entry) => entry.message),
        model,
        settings.reserveTokens,
        undefined,
        undefined,
        signal,
        undefined,
        previous?.type === "compaction" ? previous.summary : undefined,
        thinkingLevel,
        (requestModel, messages, options) =>
          modelRegistry.streamSimple(requestModel, messages, options),
      );
      if (signal?.aborted) return;
      if (!summary.text.trim()) throw new Error("Compaction returned an empty summary");
      return {
        entries: [
          ...event.entries,
          {
            type: "compaction",
            summary: summary.text,
            firstKeptEntryId,
            usage: summary.usage,
          },
        ],
      };
    } catch (error) {
      if (!signal?.aborted)
        ui?.notify(
          `Compaction failed: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
    }
  };
  pi.on("turn_end", compact);
  pi.on("agent_before_settle", compact);
}
