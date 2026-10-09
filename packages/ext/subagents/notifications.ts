import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatMs, formatTokens, formatTurns } from "./ui/agent-format.js";
import { fitLine, sanitizeSingleLine, wrapDisplayLines } from "../shared/terminal-text.js";
import {
  isMissingFinalResponse,
  MISSING_FINAL_RESPONSE_ERROR,
  type NotificationDetails,
} from "./types.js";

/** Read-only support for V1 completion messages saved in older sessions. */
export function registerNotificationRenderer(pi: ExtensionAPI) {
  pi.registerMessageRenderer<NotificationDetails>(
    "subagent-notification",
    (message, { expanded }, theme) => {
      const d = message.details;
      if (!d) return undefined;

      function renderOne(d: NotificationDetails, width: number): string[] {
        const missingFinal = isMissingFinalResponse(d.status, d.result ?? d.resultPreview);
        const status = missingFinal ? "error" : d.status;
        const isError = status === "error" || status === "stopped";
        const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
        const statusText = isError ? status : "completed";
        const lines = [
          fitLine(
            `${icon} ${theme.bold(sanitizeSingleLine(d.description))} ${theme.fg("dim", statusText)}`,
            width,
          ),
        ];

        const parts: string[] = [];
        if (d.turnCount > 0) parts.push(formatTurns(d.turnCount));
        if (d.toolUses > 0) parts.push(`${d.toolUses} tool use${d.toolUses === 1 ? "" : "s"}`);
        if (d.totalTokens > 0)
          parts.push(`${formatTokens(d.totalTokens).replace(/ token$/, "")} tokens`);
        if (d.durationMs > 0) parts.push(formatMs(d.durationMs));
        if (parts.length) lines.push(fitLine(theme.fg("dim", `  (${parts.join(" · ")})`), width));

        const result = missingFinal
          ? MISSING_FINAL_RESPONSE_ERROR
          : (d.result ?? d.resultPreview ?? "No output.");
        const gutter = "  ";
        const contentWidth = Math.max(1, width - gutter.length);
        const resultLines = wrapDisplayLines(result, contentWidth);
        for (const line of expanded ? resultLines : resultLines.slice(0, 3)) {
          lines.push(fitLine(theme.fg("dim", `${gutter}${line}`), width));
        }
        if (!expanded) lines.push(fitLine(theme.fg("dim", " (ctrl+o to expand)"), width));
        return lines;
      }

      const all = [d, ...(d.others ?? [])];
      return {
        render: (width: number) => all.flatMap((details) => renderOne(details, width)),
        invalidate() {},
      };
    },
  );
}
