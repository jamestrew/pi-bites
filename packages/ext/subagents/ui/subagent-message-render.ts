import type { Component } from "@earendil-works/pi-tui";
import type { SubagentMessageDetails } from "../subagent-messages.js";
import type { Theme } from "./agent-format.js";
import { fitLine, sanitizeSingleLine, wrapDisplayLines } from "./text-lines.js";

/** Shared incoming-message block for standalone and WaitAgent delivery. */
export function renderSubagentMessage(
  details: SubagentMessageDetails,
  expanded: boolean,
  theme: Theme,
  nested = false,
): Component {
  return {
    render(width: number): string[] {
      const invocation = [details.sender.model_name, details.sender.thinking]
        .filter(Boolean)
        .map((value) => sanitizeSingleLine(String(value)))
        .join(" ");
      const title = theme.bold(sanitizeSingleLine(details.sender.title));
      const branch = nested ? theme.fg("dim", "  └─ ") : "";
      const lines = [
        fitLine(
          `${branch}${theme.fg("toolTitle", "↳")} ${title}${invocation ? ` (${invocation})` : ""}`,
          width,
        ),
      ];
      const contentPrefix = nested ? "      " : "  ";
      const contentWidth = Math.max(1, width - contentPrefix.length);
      const messageLines = wrapDisplayLines(details.message, contentWidth);
      for (const line of expanded ? messageLines : messageLines.slice(0, 3)) {
        lines.push(fitLine(theme.fg("dim", `${contentPrefix}${line}`), width));
      }
      if (!expanded) {
        lines.push(fitLine(theme.fg("dim", "  (ctrl+o to expand)"), width));
      }
      return lines;
    },
    invalidate() {},
  };
}
