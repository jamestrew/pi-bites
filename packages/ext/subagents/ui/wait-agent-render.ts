import type { Component } from "@earendil-works/pi-tui";
import { doneStats } from "../tool-result.js";
import type { WaitAgentDetails, WaitAgentResult } from "../types.js";
import { formatTokens, type Theme } from "./agent-format.js";
import { fitLine, sanitizeSingleLine, wrapDisplayLines } from "./text-lines.js";

function formatTime(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds >= 60 && seconds % 60 === 0 ? `${seconds / 60}m` : `${seconds}s`;
}

function header(details: WaitAgentDetails, now: number, theme: Theme): string {
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
  return `WaitAgent${theme.fg("dim", ` · ${action}${timeout}`)}`;
}

function statusLine(agent: WaitAgentResult, outcome: WaitAgentDetails["outcome"]) {
  const description = sanitizeSingleLine(agent.description || agent.id);
  const invocation = [agent.model_name, agent.thinking]
    .filter(Boolean)
    .map((value) => sanitizeSingleLine(String(value)))
    .join(" ");
  const stats = agent.lifetime_usage
    ? doneStats(agent.tool_uses, agent.lifetime_usage, agent.duration_ms)
    : [
        `${agent.tool_uses} tool use${agent.tool_uses === 1 ? "" : "s"}`,
        agent.total_tokens > 0
          ? `${formatTokens(agent.total_tokens)}${agent.total_tokens === 1 ? "" : "s"}`
          : undefined,
        agent.duration_ms > 0 ? `${(agent.duration_ms / 1000).toFixed(1)}s` : undefined,
      ]
        .filter(Boolean)
        .join(" · ");
  const doneDetails = [invocation, stats].filter(Boolean).join(" · ");
  if (agent.status === "completed") return `✓ ${description} · Done (${doneDetails})`;
  if (agent.status === "error") {
    return `✗ ${description} · Error: ${sanitizeSingleLine(agent.error ?? "unknown")}${doneDetails ? ` (${doneDetails})` : ""}`;
  }
  if (agent.status === "stopped") return `■ ${description} · Stopped (${doneDetails})`;

  const suffix =
    outcome === "terminal"
      ? " · still running"
      : outcome === "timeout" || outcome === "cancelled"
        ? " · continues in background"
        : "";
  return `◷ ${description}${invocation ? ` (${invocation})` : ""}${suffix}`;
}

export function renderWaitAgent(
  details: WaitAgentDetails,
  expanded: boolean,
  theme: Theme,
): Component {
  return {
    render(width: number): string[] {
      const lines = [fitLine(header(details, Date.now(), theme), width)];

      details.agents.forEach((agent, index) => {
        const last = index === details.agents.length - 1;
        const branch = last ? "└─ " : "├─ ";
        lines.push(
          fitLine(theme.fg("dim", ` ${branch}${statusLine(agent, details.outcome)}`), width),
        );

        const gutter = last ? "      " : " │    ";
        const contentWidth = Math.max(1, width - gutter.length);
        if (expanded) {
          for (const call of agent.tool_calls ?? []) {
            const callLines = wrapDisplayLines(`→ ${call}`, contentWidth);
            for (const line of callLines) {
              lines.push(fitLine(theme.fg("dim", `${gutter}${line}`), width));
            }
          }
        }

        const output = agent.result;
        if (!output || (agent.status !== "completed" && agent.status !== "error")) return;
        const outputLines = wrapDisplayLines(output, contentWidth);
        for (const line of expanded ? outputLines : outputLines.slice(0, 3)) {
          lines.push(fitLine(theme.fg("dim", `${gutter}${line}`), width));
        }
      });

      if (
        !expanded &&
        details.agents.some((agent) => agent.result || (agent.tool_calls?.length ?? 0) > 0)
      )
        lines.push(fitLine(theme.fg("dim", " (ctrl+o to expand)"), width));
      if (details.message)
        lines.push(fitLine(theme.fg("dim", ` ${sanitizeSingleLine(details.message)}`), width));
      return lines;
    },
    invalidate() {},
  };
}
