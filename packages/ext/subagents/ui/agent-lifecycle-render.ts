import { keyHint } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type { WaitAgentStatus } from "../types.js";
import type { Theme } from "./agent-format.js";
import { fitLine, sanitizeSingleLine, wrapDisplayLines } from "./text-lines.js";

export function renderAgentLifecycle(
  toolName: string,
  getDetails: () => { metadata: (string | undefined)[]; error?: string },
  expanded: boolean,
  theme: Theme,
): Component {
  return {
    render(width: number): string[] {
      const { metadata, error } = getDetails();
      const summary = metadata.map((part) => sanitizeSingleLine(part ?? "")).filter(Boolean);
      const suffix = summary.length > 0 ? ` ${summary.join(" ")}` : "";
      const lines = [fitLine(theme.bold(toolName) + theme.fg("accent", suffix), width)];
      if (error) {
        const details = wrapDisplayLines(`Error: ${error}`, Math.max(1, width));
        lines.push(
          "",
          ...(expanded ? details : details.slice(0, 8)).map((line) =>
            fitLine(theme.fg("dim", line), width),
          ),
        );
        if (!expanded && details.length > 8) {
          lines.push(
            fitLine(theme.fg("dim", `(${keyHint("app.tools.expand", "to expand")})`), width),
          );
        }
      }
      return lines;
    },
    invalidate() {},
  };
}

export function lifecycleStatusLabel(status: WaitAgentStatus, pendingInitLabel: string): string {
  if (typeof status === "string") return status === "pending_init" ? pendingInitLabel : status;
  if ("completed" in status) return "completed";
  return "errored";
}
