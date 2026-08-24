import type { Component } from "@earendil-works/pi-tui";
import { doneStats } from "../tool-result.js";
import {
  isMissingFinalResponse,
  MISSING_FINAL_RESPONSE_ERROR,
  type WaitAgentDetails,
  type WaitAgentResult,
} from "../types.js";
import { formatTokens, type Theme } from "./agent-format.js";
import { renderSubagentMessage } from "./subagent-message-render.js";
import { fitLine, sanitizeSingleLine, wrapDisplayLines } from "./text-lines.js";

function formatTime(ms: number): string {
  const seconds = Math.max(0, ms) / 1000;
  if (seconds < 1) return "0s";
  if (seconds >= 60 && seconds % 60 === 0) return `${seconds / 60}m`;
  return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)}s`;
}

function header(details: WaitAgentDetails, now: number, theme: Theme): string {
  const endedAt = details.wait_ended_at ?? now;
  const elapsed = formatTime(endedAt - (details.wait_started_at ?? endedAt));
  const action =
    details.outcome === "waiting"
      ? `waiting ${elapsed}`
      : details.outcome === "terminal"
        ? `waited ${elapsed}`
        : details.outcome === "message"
          ? `received message after ${elapsed}`
          : details.outcome === "timeout"
            ? `timed out after ${elapsed}`
            : details.outcome === "cancelled"
              ? `cancelled after ${elapsed}`
              : `failed after ${elapsed}`;
  const timeout =
    details.timeout_ms !== undefined && details.outcome !== "timeout"
      ? ` / timeout ${formatTime(details.timeout_ms)}`
      : "";
  return `${theme.bold("WaitAgent")}${theme.fg("dim", ` · ${action}${timeout}`)}`;
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
  const missingFinal = isMissingFinalResponse(agent.status, agent.result);
  if (agent.status === "completed" && !missingFinal)
    return `✓ ${description} · Done (${doneDetails})`;
  if (agent.status === "error" || missingFinal) {
    const error = missingFinal ? MISSING_FINAL_RESPONSE_ERROR : (agent.error ?? "unknown");
    return `✗ ${description} · Error: ${sanitizeSingleLine(error)}${doneDetails ? ` (${doneDetails})` : ""}`;
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

      if (details.outcome === "message") {
        lines.push(
          ...renderSubagentMessage(
            {
              sender: {
                id: details.sender.id,
                type: details.sender.type,
                title: details.sender.title,
                model_name: details.sender.model_name,
                thinking: details.sender.thinking,
              },
              message: details.message,
            },
            expanded,
            theme,
            true,
          ).render(width),
        );
        return lines;
      }

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
        if (!output?.trim() || (agent.status !== "completed" && agent.status !== "error")) return;
        const outputLines = wrapDisplayLines(output, contentWidth);
        for (const line of expanded ? outputLines : outputLines.slice(0, 3)) {
          lines.push(fitLine(theme.fg("dim", `${gutter}${line}`), width));
        }
      });

      if (
        !expanded &&
        details.agents.some((agent) => agent.result?.trim() || (agent.tool_calls?.length ?? 0) > 0)
      )
        lines.push(fitLine(theme.fg("dim", " (ctrl+o to expand)"), width));
      if (details.outcome === "error")
        lines.push(fitLine(theme.fg("dim", ` ${sanitizeSingleLine(details.message)}`), width));
      return lines;
    },
    invalidate() {},
  };
}
