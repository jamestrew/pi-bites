import {
  type AgentToolResult,
  type ToolDefinition,
  type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { type Component, Text, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { doneStats } from "../tool-result.js";
import { type AgentDetails, formatTurns, SPINNER, type Theme } from "./agent-format.js";
import { summarizeToolArg, wrapMultilineText } from "./tool-call-format.js";

function formatStats(details: AgentDetails): string {
  const parts: string[] = [];
  if (details.modelName) parts.push(details.modelName);
  if (details.tags) parts.push(...details.tags);
  if (details.turnCount != null && details.turnCount > 0)
    parts.push(formatTurns(details.turnCount));
  if (details.status === "running") {
    if (details.toolUses > 0)
      parts.push(`${details.toolUses} tool use${details.toolUses === 1 ? "" : "s"}`);
    if (details.tokens) parts.push(details.tokens);
    return parts.join(" · ");
  }
  return doneStats(
    details.toolCalls?.length ?? details.toolUses,
    details.lifetimeUsage ?? { input: 0, output: 0, cacheWrite: 0 },
    details.durationMs,
  );
}

function renderStatus(details: AgentDetails, theme: Theme, stats: string): string[] {
  if (details.status === "running") {
    const frame = SPINNER[details.spinnerFrame ?? 0];
    return [
      theme.fg("accent", frame) + (stats ? theme.fg("dim", ` ${stats}`) : ""),
      theme.fg("dim", details.activity ?? "thinking…"),
    ];
  }
  if (details.status === "background")
    return [
      theme.fg("accent", "●") + theme.fg("dim", ` Running in background (ID: ${details.agentId})`),
    ];
  if (details.status === "error")
    return [theme.fg("error", `Error: ${details.error ?? "unknown"}`)];
  if (details.status === "stopped") return [theme.fg("muted", "Stopped")];
  return [];
}

type ToolRenderContext = Omit<
  Parameters<NonNullable<ToolDefinition["renderResult"]>>[3],
  "args"
> & { args: { prompt?: unknown } };

export function renderAgentToolResult(
  result: AgentToolResult<AgentDetails | undefined>,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: ToolRenderContext,
): Component {
  const details = result.details;
  const resultText = result.content[0]?.type === "text" ? result.content[0].text : "";
  if (!details) return new Text(resultText, 0, 0);

  return {
    render(width: number): string[] {
      const lineWidth = Math.max(1, width - 3);
      const lines: string[] = [];
      const stats = formatStats(details);

      if (options.expanded) {
        const prompt = String(context.args.prompt ?? "").trim();
        if (prompt) {
          lines.push(theme.fg("muted", "Prompt:"));
          for (const line of wrapTextWithAnsi(prompt, lineWidth)) lines.push(theme.fg("dim", line));
          lines.push("");
        }

        if (details.status === "running" || options.isPartial) {
          const frame = SPINNER[details.spinnerFrame ?? 0];
          lines.push(
            theme.fg("accent", frame) + (stats ? theme.fg("dim", ` ${stats}`) : ""),
            theme.fg("dim", details.activity ?? "thinking…"),
          );
        } else {
          lines.push(...renderStatus(details, theme, stats));
        }

        for (const call of details.toolCalls ?? [])
          for (const line of wrapMultilineText(call, lineWidth)) lines.push(theme.fg("dim", line));

        if (resultText.trim()) {
          if (lines.length > 0) lines.push("");
          lines.push(...wrapTextWithAnsi(resultText.trim(), lineWidth));
        }

        lines.push("");
        if (details.status === "running" || options.isPartial) {
          lines.push(theme.fg("muted", "Running…"));
        } else if (details.status === "background") {
          lines.push(theme.fg("muted", "Background agent running…"));
        } else {
          const isDone = details.status === "completed";
          lines.push(
            theme.fg(isDone ? "success" : "muted", isDone ? "Done" : "Finished") +
              (stats ? theme.fg("muted", ` (${stats})`) : ""),
          );
        }
      } else if (details.status === "running" || options.isPartial) {
        const toolCalls = details.toolCalls ?? [];
        for (const call of toolCalls.slice(-3))
          lines.push(truncateToWidth(theme.fg("dim", summarizeToolArg(call)), lineWidth, "…"));
        lines.push(theme.fg("muted", "Running… (ctrl+o to expand)"));
        const hiddenCount = Math.max(0, toolCalls.length - 3);
        if (hiddenCount > 0) lines.push(theme.fg("muted", `+${hiddenCount} more tool uses`));
      } else {
        lines.push(...renderStatus(details, theme, stats));
        if (lines.length === 0) {
          const isDone = details.status === "completed";
          const summary = stats.replace(/^(\d+) tool uses?/, "+$1 more tool uses");
          lines.push(
            theme.fg(isDone ? "success" : "warning", "Done") +
              (summary ? theme.fg("muted", ` (${summary})`) : ""),
          );
          if ((details.toolCalls?.length ?? 0) > 0)
            lines.push(theme.fg("muted", "(ctrl+o to expand)"));
        }
      }

      const prefix = theme.fg("dim", "⎿  ");
      return lines.map((line, index) => (index === 0 ? prefix + line : `   ${line}`));
    },
    invalidate() {},
  };
}
