import {
  buildSessionProjection,
  SessionManager,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { SubagentMessageDetails } from "./subagent-messages.js";

/** Materialize recent task context, not old summaries or reference-bearing edit records. */
export function recentTurnEntries(entries: SessionEntry[], count: bigint): SessionEntry[] {
  const projected = buildSessionProjection(entries).entries;
  const boundaries = projected.flatMap(({ messages }, index) =>
    messages.some(
      (message) =>
        message.role === "user" ||
        (message.role === "custom" &&
          message.customType === "subagent-message" &&
          (message.details as Partial<SubagentMessageDetails> | undefined)?.task === true),
    )
      ? [index]
      : [],
  );
  const start = boundaries[Math.max(0, boundaries.length - Number(count))];
  if (start === undefined) return [];

  const selected = SessionManager.inMemory("/");
  const calls = new Set<string>();
  for (const { messages } of projected.slice(start)) {
    for (const message of messages) {
      switch (message.role) {
        case "assistant":
          for (const block of message.content) if (block.type === "toolCall") calls.add(block.id);
          selected.appendMessage(structuredClone(message));
          break;
        case "toolResult":
          // Context edits or a truncated compaction prefix can remove the originating call.
          if (calls.delete(message.toolCallId)) selected.appendMessage(structuredClone(message));
          break;
        case "user":
        case "bashExecution":
          selected.appendMessage(structuredClone(message));
          break;
        case "custom":
          selected.appendCustomMessageEntry(
            message.customType,
            structuredClone(message.content),
            message.display,
            structuredClone(message.details),
          );
          break;
        // Summaries cover older tasks; historical system deltas can depend on omitted state.
        // The runner constructs the child's own system prompt and permitted tool loadout.
        case "system":
        case "compactionSummary":
        case "branchSummary":
          break;
      }
    }
  }
  return selected.buildContextEntries();
}
