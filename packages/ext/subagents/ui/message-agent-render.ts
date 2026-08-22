import type { Component } from "@earendil-works/pi-tui";
import type { Theme } from "./agent-format.js";
import { fitLine, sanitizeSingleLine, wrapDisplayLines } from "./text-lines.js";

export type MessageAgentStatus = "sent" | "queued" | "failed";

export function renderMessageAgentCall(recipient = "", message = "", theme: Theme): Component {
  return {
    render(width: number): string[] {
      const lines = [
        fitLine(
          theme.fg("toolTitle", theme.bold("MessageAgent")) +
            theme.fg("dim", ` → ${sanitizeSingleLine(recipient)}`),
          width,
        ),
      ];
      const contentWidth = Math.max(1, width - 2);
      for (const line of wrapDisplayLines(message, contentWidth)) {
        lines.push(fitLine(theme.fg("dim", `  ${line}`), width));
      }
      return lines;
    },
    invalidate() {},
  };
}

export function renderMessageAgentResult(status: MessageAgentStatus, theme: Theme): Component {
  return {
    render: (width: number) => [fitLine(theme.fg("dim", `  ⎿ ${status}`), width)],
    invalidate() {},
  };
}
