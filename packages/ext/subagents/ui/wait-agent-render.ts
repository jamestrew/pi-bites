import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { doneStats } from "../tool-result.js";
import type { WaitAgentDetails, WaitAgentResult } from "../types.js";
import type { Theme } from "./agent-format.js";
import { sanitizeText, wrapDisplayLines } from "./text-lines.js";

function formatTime(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds >= 60 && seconds % 60 === 0 ? `${seconds / 60}m` : `${seconds}s`;
}

function header(details: WaitAgentDetails, now: number): string {
  const endedAt = details.wait_ended_at ?? now;
  const elapsed = formatTime(endedAt - (details.wait_started_at ?? endedAt));
  const action =
    details.outcome === "waiting"
      ? `waiting ${elapsed}`
      : details.outcome === "terminal"
        ? `waited ${elapsed}`
        : details.outcome === "timeout"
          ? `timed out after ${elapsed}`
          : details.outcome === "cancelled"
            ? `cancelled after ${elapsed}`
            : `failed after ${elapsed}`;
  const timeout =
    details.timeout_ms !== undefined && details.outcome !== "timeout"
      ? ` / timeout ${formatTime(details.timeout_ms)}`
      : "";
  return `WaitAgent · ${action}${timeout}`;
}

function statusLine(agent: WaitAgentResult, outcome: WaitAgentDetails["outcome"], theme: Theme) {
  const description = sanitizeText(agent.description || agent.id);
  const lifetimeUsage = agent.lifetime_usage ?? {
    input: agent.total_tokens,
    output: 0,
    cacheWrite: 0,
  };
  const stats = doneStats(agent.tool_uses, lifetimeUsage, agent.duration_ms);
  if (agent.status === "completed") {
    return theme.fg("success", "✓") + ` ${description} · ` + theme.fg("muted", `Done (${stats})`);
  }
  if (agent.status === "error") {
    return `${theme.fg("error", "✗")} ${description} · ${theme.fg("error", `Error: ${sanitizeText(agent.error ?? "unknown")}`)}${stats ? theme.fg("muted", ` (${stats})`) : ""}`;
  }
  if (agent.status === "stopped") {
    return `${theme.fg("muted", "■")} ${description} · ${theme.fg("muted", `Stopped (${stats})`)}`;
  }

  const suffix =
    outcome === "terminal"
      ? " · still running"
      : outcome === "timeout" || outcome === "cancelled"
        ? " · continues in background"
        : "";
  return `${theme.fg("accent", "◷")} ${description}${theme.fg("dim", suffix)}`;
}

export function renderWaitAgent(
  details: WaitAgentDetails,
  expanded: boolean,
  theme: Theme,
): Component {
  return {
    render(width: number): string[] {
      const lines = [truncateToWidth(header(details, Date.now()), width, "…")];

      details.agents.forEach((agent, index) => {
        const last = index === details.agents.length - 1;
        const branch = last ? "└─ " : "├─ ";
        lines.push(
          truncateToWidth(
            theme.fg("dim", ` ${branch}`) + statusLine(agent, details.outcome, theme),
            width,
            "…",
          ),
        );

        const output = agent.result;
        if (!output || (agent.status !== "completed" && agent.status !== "error")) return;
        const gutter = last ? "    │ " : " │  │ ";
        const contentWidth = Math.max(1, width - gutter.length);
        const outputLines = wrapDisplayLines(output, contentWidth);
        for (const line of expanded ? outputLines : outputLines.slice(0, 3)) {
          lines.push(theme.fg("dim", gutter) + truncateToWidth(line, contentWidth, "…"));
        }
      });

      if (!expanded && details.agents.some((agent) => agent.result))
        lines.push(truncateToWidth(theme.fg("dim", " (ctrl+o to expand)"), width, "…"));
      if (details.message)
        lines.push(
          truncateToWidth(theme.fg("error", ` ${sanitizeText(details.message)}`), width, "…"),
        );
      return lines;
    },
    invalidate() {},
  };
}
