import { Text } from "@earendil-works/pi-tui";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getSessionContextPercent, getLifetimeTotal } from "./usage.js";
import { getStatusNote } from "./status-note.js";
import { type AgentActivity, formatMs, formatTokens, formatTurns } from "./ui/agent-format.js";
import { type AgentRecord, type NotificationDetails } from "./types.js";

/** Human-readable status label for agent completion. */
function getStatusLabel(status: string, error?: string): string {
  switch (status) {
    case "error":
      return `Error: ${error ?? "unknown"}`;
    case "stopped":
      return "Stopped";
    default:
      return "Done";
  }
}

/** Escape XML special characters to prevent injection in structured notifications. */
function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Format a structured task notification matching Claude Code's <task-notification> XML. */
export function formatTaskNotification(record: AgentRecord): string {
  const status = getStatusLabel(record.status, record.error);
  const durationMs = record.completedAt ? record.completedAt - record.startedAt : 0;
  const totalTokens = getLifetimeTotal(record.lifetimeUsage);
  const contextPercent = getSessionContextPercent(record.session);
  const ctxXml =
    contextPercent !== null
      ? `<context_percent>${Math.round(contextPercent)}</context_percent>`
      : "";
  const compactXml = record.compactionCount
    ? `<compactions>${record.compactionCount}</compactions>`
    : "";

  const result = record.result || "No output.";

  return [
    `<task-notification>`,
    `<task-id>${record.id}</task-id>`,
    record.toolCallId ? `<tool-use-id>${escapeXml(record.toolCallId)}</tool-use-id>` : null,
    `<status>${escapeXml(status)}</status>`,
    `<summary>Agent "${escapeXml(record.description)}" ${record.status}${getStatusNote(record.status)}</summary>`,
    `<result>${escapeXml(result)}</result>`,
    `<usage><total_tokens>${totalTokens}</total_tokens><tool_uses>${record.toolUses}</tool_uses>${ctxXml}${compactXml}<duration_ms>${durationMs}</duration_ms></usage>`,
    `</task-notification>`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Build notification details for the custom message renderer. */
export function buildNotificationDetails(
  record: AgentRecord,
  activity?: AgentActivity,
): NotificationDetails {
  const totalTokens = getLifetimeTotal(record.lifetimeUsage);

  return {
    id: record.id,
    description: record.description,
    status: record.status,
    toolUses: record.toolUses,
    turnCount: activity?.turnCount ?? 0,
    totalTokens,
    durationMs: record.completedAt ? record.completedAt - record.startedAt : 0,
    error: record.error,
    result: record.result || "No output.",
  };
}

export function registerNotificationRenderer(pi: ExtensionAPI) {
  pi.registerMessageRenderer<NotificationDetails>(
    "subagent-notification",
    (message, { expanded }, theme) => {
      const d = message.details;
      if (!d) return undefined;

      function renderOne(d: NotificationDetails): string {
        const isError = d.status === "error" || d.status === "stopped";
        const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
        const statusText = isError ? d.status : "completed";
        let text = `${icon} ${theme.bold(d.description)} ${theme.fg("dim", statusText)}`;

        const parts: string[] = [];
        if (d.turnCount > 0) parts.push(formatTurns(d.turnCount));
        if (d.toolUses > 0) parts.push(`${d.toolUses} tool use${d.toolUses === 1 ? "" : "s"}`);
        if (d.totalTokens > 0)
          parts.push(`${formatTokens(d.totalTokens).replace(/ token$/, "")} tokens`);
        if (d.durationMs > 0) parts.push(formatMs(d.durationMs));
        if (parts.length) text += `\n  ${theme.fg("dim", parts.join(" · "))}`;

        const result = d.result ?? d.resultPreview ?? "No output.";
        const lines = result.split("\n");
        for (const line of expanded ? lines : lines.slice(0, 3)) {
          text += `\n${theme.fg("dim", " │ ")}${line}`;
        }
        if (!expanded) text += `\n${theme.fg("dim", " (ctrl+o to expand)")}`;
        return text;
      }

      const all = [d, ...(d.others ?? [])];
      return new Text(all.map(renderOne).join("\n"), 0, 0);
    },
  );
}
