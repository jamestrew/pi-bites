import { keyHint } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type { Theme } from "./agent-format.js";
import { fitLine, sanitizeSingleLine, wrapDisplayLines } from "./text-lines.js";

export type SendInputStatus = "queued" | "interrupted" | "failed";

export type SendInputRenderState = {
  recipient?: string;
  message: string;
  interrupt: boolean;
  status?: SendInputStatus;
  error?: string;
};

export function renderSendInputCall(
  state: SendInputRenderState,
  expanded: boolean,
  theme: Theme,
): Component {
  return {
    render(width: number): string[] {
      const metadata = [
        sanitizeSingleLine(state.recipient ?? ""),
        state.interrupt ? "interrupt" : undefined,
        state.status,
      ].filter(Boolean);
      const lines = [
        fitLine(theme.bold("send_input") + theme.fg("accent", ` → ${metadata.join(" · ")}`), width),
        "",
      ];
      const messageLines = wrapDisplayLines(state.message, Math.max(1, width));
      for (const line of expanded ? messageLines : messageLines.slice(0, 3))
        lines.push(fitLine(theme.fg("dim", line), width));
      if (!expanded && messageLines.length > 3)
        lines.push(fitLine(theme.fg("dim", `(${expandHint()})`), width));
      if (state.error)
        lines.push(
          "",
          fitLine(theme.fg("dim", `Error: ${sanitizeSingleLine(state.error)}`), width),
        );
      return lines;
    },
    invalidate() {},
  };
}

function expandHint(): string {
  try {
    return keyHint("app.tools.expand", "to expand");
  } catch {
    return "ctrl+o to expand";
  }
}
