import { Type } from "typebox";
import { Check } from "typebox/value";
import { CODEX_V2_CONTRACT } from "../codex-v2-contract.js";
import { Container } from "@earendil-works/pi-tui";
import { keyHint } from "@earendil-works/pi-coding-agent";
import { extractText } from "../message-text.js";
import { lifecycleStatusLabel } from "./agent-lifecycle-render.js";
import { getAgentStatus } from "../agent-status.js";
import { buildDoneStats } from "./tool-call-format.js";
import type { LifetimeUsage } from "../usage.js";
import type { AgentRecord, WaitAgentStatus } from "../types.js";
import { fitLine, sanitizeSingleLine, wrapDisplayLines } from "./text-lines.js";

export type AgentSnapshot = {
  path: string;
  status: string;
  model?: string;
  thinking?: string;
  durationMs?: number;
  toolUses?: number;
  usage?: LifetimeUsage;
  toolCalls?: string[];
  children?: number;
  runningChildren?: number;
};

export function snapshotAgent(record: AgentRecord, now: number): AgentSnapshot {
  return {
    path: record.taskName ?? record.id,
    status: lifecycleStatusLabel(getAgentStatus(record, false), "pending_init"),
    model: record.invocation?.modelName,
    thinking: record.invocation?.thinking,
    durationMs: Math.max(0, (record.completedAt ?? now) - record.startedAt),
    toolUses: record.toolUses,
    usage: { ...record.lifetimeUsage },
  };
}

function listRow(agent: AgentSnapshot): string {
  const parts = [`${agent.path} ${agent.status}`];
  const model = [agent.model, agent.thinking].filter(Boolean).join(" ");
  if (model) parts.push(model);
  if (agent.durationMs !== undefined) parts.push(seconds(agent.durationMs));
  if (agent.toolUses !== undefined) {
    const stats =
      agent.status === "completed" && agent.usage
        ? buildDoneStats(agent.toolUses, agent.usage)
        : `${agent.toolUses} tool uses`;
    parts.push(stats.replace(/tool uses?/, "tools"));
  }
  return sanitizeSingleLine(parts.join(" · "));
}

export type WaitSnapshot = {
  outcome: "waiting" | "completed" | "input" | "timeout" | "cancelled" | "failed";
  elapsedMs: number;
  requestedMs: number;
  timeoutMs: number;
  agents: AgentSnapshot[];
};

function seconds(ms: number): string {
  return `${Number((ms / 1000).toFixed(1))}s`;
}
function waitSummary(wait: WaitSnapshot): string {
  if (wait.outcome === "waiting")
    return `waiting ${seconds(wait.elapsedMs)} / timeout ${seconds(wait.timeoutMs)}`;
  if (wait.outcome === "failed") return "failed";
  const outcome = {
    completed: "completed",
    input: "interrupted by new input",
    timeout: "timed out",
    cancelled: "cancelled",
  }[wait.outcome];
  return `${outcome} after ${seconds(wait.elapsedMs)}`;
}

function waitLines(
  wait: WaitSnapshot,
  width: number,
  expanded: boolean,
): { lines: string[]; hidden: boolean } {
  const lines: string[] = [];
  let hidden = false;
  if (wait.requestedMs < wait.timeoutMs)
    lines.push(
      ...wrapDisplayLines(
        `Requested timeout ${seconds(wait.requestedMs)} raised to the minimum of ${seconds(wait.timeoutMs)}.`,
        width,
      ),
    );
  if (lines.length && wait.agents.length) lines.push("");
  wait.agents.forEach((agent, index) => {
    const last = index === wait.agents.length - 1;
    const branch = last ? "└─ " : "├─ ";
    const indent = last ? "   " : "│  ";
    const parts = [`${agent.path.slice(agent.path.lastIndexOf("/") + 1)} ${agent.status}`];
    const model = [agent.model, agent.thinking].filter(Boolean).join(" ");
    if (model) parts.push(model);
    if (agent.children)
      parts.push(`${agent.children} subagents (${agent.runningChildren ?? 0} running)`);
    const wrap = (text: string, first: string) =>
      wrapDisplayLines(text, Math.max(1, width - 3)).map(
        (line, i) => `${i ? indent : first}${line}`,
      );
    lines.push(...wrap(parts.join(" · "), branch));
    if (agent.status === "completed" && agent.toolUses !== undefined && agent.usage)
      lines.push(...wrap(buildDoneStats(agent.toolUses, agent.usage, agent.durationMs), indent));
    const calls = agent.toolCalls ?? [];
    const visible = expanded ? calls : agent.status === "running" ? calls.slice(-1) : [];
    if (calls.length > visible.length) hidden = true;
    for (const call of visible) lines.push(...wrap(`→ ${call}`, indent));
  });
  return { lines, hidden };
}

const listResultSchema = Type.Unsafe<{
  agents: Array<{ agent_name: string; agent_status: WaitAgentStatus }>;
}>(CODEX_V2_CONTRACT.tools.list_agents.output_schema);
const interruptResultSchema = Type.Unsafe<{ previous_status: WaitAgentStatus }>(
  CODEX_V2_CONTRACT.tools.interrupt_agent.output_schema,
);

type Receipt = {
  target?: string;
  previousStatus?: string;
  prefix?: string;
  agents?: AgentSnapshot[];
  wait?: WaitSnapshot;
};
type State = { receipt?: Receipt; error?: string; legacyWait?: string; legacyStatus?: string };

/** The host owns padding/background; the call component reads state after renderResult runs. */
export function observationReceiptRenderers(
  name: "interrupt_agent" | "list_agents" | "wait_agent",
) {
  return {
    renderCall(
      args: { target?: string; path_prefix?: string; timeout_ms?: number; targets?: unknown[] },
      theme: { bold(s: string): string; fg(color: "accent" | "dim", s: string): string },
      context: { state: State; expanded: boolean },
    ) {
      const { state } = context;
      return {
        render(width: number) {
          const receipt = state.receipt;
          const wait = receipt?.wait;
          let summary: string;
          if (name === "wait_agent") {
            if (Array.isArray(args.targets)) summary = `${args.targets.length} agents`;
            else if (wait) summary = waitSummary(wait);
            else if (state.error)
              summary = /cancelled|aborted/i.test(state.error) ? "cancelled" : "failed";
            else
              summary =
                state.legacyStatus ??
                `waiting 0s / timeout ${seconds(Math.max(10000, args.timeout_ms ?? 30000))}`;
          } else if (name === "list_agents") {
            summary = `${receipt?.prefix ?? args.path_prefix ?? "/root"}${receipt?.agents ? ` ${receipt.agents.length} loaded` : ""}`;
          } else {
            summary = `${receipt?.target ?? args.target ?? ""}${receipt?.previousStatus ? " interrupt requested" : ""}`;
          }
          const lines = [
            fitLine(
              theme.bold(name) + theme.fg("accent", ` ${sanitizeSingleLine(summary)}`),
              width,
            ),
          ];
          const body =
            state.error ??
            (receipt?.previousStatus ? `Previous status: ${receipt.previousStatus}` : "");
          const activity = wait ? waitLines(wait, width, context.expanded) : undefined;
          const details =
            activity?.lines ??
            (state.legacyWait
              ? wrapDisplayLines(state.legacyWait, width)
              : (receipt?.agents ?? []).map(listRow));
          const trailing = body ? wrapDisplayLines(body, width) : [];
          const budget = context.expanded ? Infinity : 8;
          const tail = trailing.slice(0, budget);
          const preview = details.slice(
            0,
            Math.max(0, budget - tail.length - (tail.length && details.length ? 1 : 0)),
          );
          const visible = [...preview, ...(preview.length && tail.length ? [""] : []), ...tail];
          if (visible.length)
            lines.push("", ...visible.map((line) => fitLine(theme.fg("dim", line), width)));
          if (
            !context.expanded &&
            (details.length > preview.length || trailing.length > tail.length || activity?.hidden)
          ) {
            let hint = "ctrl+o to expand";
            try {
              hint = keyHint("app.tools.expand", "to expand");
            } catch {
              /* Print mode has no keybindings. */
            }
            lines.push(fitLine(theme.fg("dim", `(${hint})`), width));
          }
          return lines;
        },
        invalidate() {},
      };
    },
    renderResult(
      result: { content: Array<{ type: string; text?: string }>; details?: unknown },
      options: { isPartial?: boolean },
      _theme: unknown,
      context: { state: State; isError: boolean },
    ) {
      if (context.isError) {
        const error = sanitizeSingleLine(
          extractText(result.content)
            .split("\n")
            .find((line) => line.trim()) ?? "Operation failed",
        );
        context.state.error = error.startsWith("Error:") ? error : `Error: ${error}`;
        const details = result.details as Receipt | undefined;
        context.state.receipt = details?.wait ? { wait: details.wait } : undefined;
      } else {
        context.state.error = undefined;
        const details = result.details as Receipt | undefined;
        if (name === "wait_agent") {
          const legacy = result.details as
            | { agents?: unknown[]; outcome?: string; status?: string }
            | undefined;
          if (!details?.wait && Array.isArray(legacy?.agents) && legacy.outcome)
            context.state.legacyWait = extractText(result.content);
          if (!details?.wait && legacy?.status)
            context.state.legacyStatus = legacy.status
              .replace(/^Wait /, "")
              .replace(/\.$/, "")
              .toLowerCase();
        }
        if (options.isPartial && name !== "wait_agent") return new Container();
        let previousStatus = details?.previousStatus;
        if (name === "interrupt_agent" && !previousStatus) {
          try {
            const value: unknown = JSON.parse(extractText(result.content));
            if (Check(interruptResultSchema, value))
              previousStatus = lifecycleStatusLabel(value.previous_status, "pending_init");
          } catch {
            /* Older/incomplete results may lack a receipt. */
          }
        }
        let agents = details?.agents;
        if (name === "list_agents" && !agents) {
          try {
            const value: unknown = JSON.parse(extractText(result.content));
            if (Check(listResultSchema, value))
              agents = value.agents.map((agent) => ({
                path: agent.agent_name,
                status: lifecycleStatusLabel(agent.agent_status, "pending_init"),
              }));
          } catch {
            /* Saved lists have only model-facing identity/status. */
          }
        }
        context.state.receipt = { ...details, previousStatus, agents };
      }
      return new Container();
    },
  };
}
