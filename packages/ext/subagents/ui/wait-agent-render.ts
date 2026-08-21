import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { doneStats } from "../tool-result.js";
import type { WaitAgentDetails, WaitAgentResult } from "../types.js";
import type { Theme } from "./agent-format.js";

function formatTime(ms: number): string {
  const seconds = ms / 1000;
  return `${Number(seconds.toFixed(seconds < 10 && !Number.isInteger(seconds) ? 1 : 0))}s`;
}

function header(details: WaitAgentDetails, now: number): string {
  const elapsed = formatTime((details.wait_ended_at ?? now) - details.wait_started_at);
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
  const description = agent.description || agent.id;
  if (agent.status === "completed") {
    return (
      theme.fg("success", "✓") +
      ` ${description} · ` +
      theme.fg(
        "muted",
        `Done (${doneStats(agent.tool_uses, agent.lifetime_usage, agent.duration_ms)})`,
      )
    );
  }
  if (agent.status === "error") {
    const stats = doneStats(agent.tool_uses, agent.lifetime_usage, agent.duration_ms);
    return `${theme.fg("error", "✗")} ${description} · ${theme.fg("error", `Error: ${agent.error ?? "unknown"}`)}${stats ? theme.fg("muted", ` (${stats})`) : ""}`;
  }
  if (agent.status === "stopped") {
    return `${theme.fg("muted", "■")} ${description} · ${theme.fg("muted", "Stopped")}`;
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

        const output = agent.result?.trim();
        if (!output || (agent.status !== "completed" && agent.status !== "error")) return;
        const sourceLines = output.split("\n");
        const shown = expanded ? sourceLines : sourceLines.slice(0, 3);
        const gutter = last ? "    │ " : " │  │ ";
        const contentWidth = Math.max(1, width - gutter.length);
        for (const sourceLine of shown) {
          const wrapped = wrapTextWithAnsi(sourceLine, contentWidth);
          for (const line of wrapped.length > 0 ? wrapped : [""]) {
            lines.push(theme.fg("dim", gutter) + truncateToWidth(line, contentWidth, "…"));
          }
        }
      });

      if (!expanded && details.agents.some((agent) => agent.result?.trim()))
        lines.push(theme.fg("dim", " (ctrl+o to expand)"));
      if (details.message) lines.push(theme.fg("error", ` ${details.message}`));
      return lines;
    },
    invalidate() {},
  };
}
