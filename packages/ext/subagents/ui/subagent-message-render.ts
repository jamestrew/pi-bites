import type { Component } from "@earendil-works/pi-tui";
import type { SubagentMessageDetails } from "../subagent-messages.js";
import type { Theme } from "./agent-format.js";
import { fitLine, sanitizeSingleLine, wrapDisplayLines } from "./text-lines.js";

/** Shared incoming-message block; WaitAgent can nest this later. */
export function renderSubagentMessage(
  details: SubagentMessageDetails,
  expanded: boolean,
  theme: Theme,
): Component {
  return {
    render(width: number): string[] {
      const lines = [
        fitLine(
          `${theme.fg("toolTitle", "↳")} ${theme.bold(sanitizeSingleLine(details.sender.title))} sent a message`,
          width,
        ),
      ];
      const contentWidth = Math.max(1, width - 2);
      const messageLines = wrapDisplayLines(details.message, contentWidth);
      for (const line of expanded ? messageLines : messageLines.slice(0, 3)) {
        lines.push(fitLine(theme.fg("dim", `  ${line}`), width));
      }
      if (!expanded) {
        lines.push(fitLine(theme.fg("dim", "  (ctrl+o to expand)"), width));
      }
      return lines;
    },
    invalidate() {},
  };
}
