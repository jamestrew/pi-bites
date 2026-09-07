import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildWaitAgentResult } from "./agent-completion.js";
import { getWaitAgentToolParameters } from "./agent-tool-description.js";
import { CODEX_V1_CONTRACT } from "./codex-v1-contract.js";
import { SUBAGENT_TOOL_NAMES } from "./agent-runner.js";
import { textResult } from "./tool-result.js";
import type { AgentRecord, WaitAgentDetails, WaitAgentOutcome, WaitAgentResult } from "./types.js";
import { renderWaitAgent } from "./ui/wait-agent-render.js";

export const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
export const MIN_WAIT_TIMEOUT_MS = 10_000;
export const MAX_WAIT_TIMEOUT_MS = 60 * 60_000;

type WaitAgentDeps = {
  waitFor: (
    agentIds: string[],
    timeoutMs: number,
    signal?: AbortSignal,
  ) => Promise<WaitAgentOutcome>;
  getRecord: (id: string) => AgentRecord | undefined;
};

export function registerWaitAgent(pi: ExtensionAPI, deps: WaitAgentDeps): void {
  const withDisplayDetails = (agent: WaitAgentResult): WaitAgentResult => {
    const record = deps.getRecord(agent.id);
    if (!record) return agent;
    const omitted =
      record.omittedToolCalls > 0
        ? [`… ${record.omittedToolCalls} earlier tool calls omitted`]
        : [];
    return {
      ...agent,
      ...(record.invocation?.modelName ? { model_name: record.invocation.modelName } : {}),
      ...(record.invocation?.thinking ? { thinking: record.invocation.thinking } : {}),
      ...(omitted.length > 0 || record.toolCalls.length > 0
        ? { tool_calls: [...omitted, ...record.toolCalls] }
        : {}),
    };
  };

  pi.registerTool(
    defineTool({
      name: SUBAGENT_TOOL_NAMES.WAIT_AGENT,
      label: "wait_agent",
      description: CODEX_V1_CONTRACT.tools.wait_agent.description,
      parameters: getWaitAgentToolParameters(),
      async execute(_toolCallId, params, signal, onUpdate) {
        const startedAt = Date.now();
        const details = (): WaitAgentDetails => ({
          outcome: "waiting",
          timed_out: false,
          agents: params.targets
            .map(deps.getRecord)
            .filter((record): record is AgentRecord => Boolean(record))
            .map((record) => withDisplayDetails(buildWaitAgentResult(record, false))),
          wait_started_at: startedAt,
          ...(params.timeout_ms === undefined ? {} : { timeout_ms: params.timeout_ms }),
        });
        const update = () =>
          onUpdate?.({
            content: [{ type: "text", text: "Waiting for a selected agent…" }],
            details: details(),
          });
        update();
        const timer = onUpdate ? setInterval(update, 1_000) : undefined;
        timer?.unref();

        try {
          if (params.timeout_ms !== undefined && params.timeout_ms <= 0) {
            const message = "timeout_ms must be greater than zero";
            return textResult(message, {
              outcome: "error",
              timed_out: false,
              status: {},
              message,
              agents: details().agents,
              wait_started_at: startedAt,
              wait_ended_at: Date.now(),
              timeout_ms: params.timeout_ms,
            });
          }
          const timeoutMs = Math.min(
            MAX_WAIT_TIMEOUT_MS,
            Math.max(MIN_WAIT_TIMEOUT_MS, params.timeout_ms ?? DEFAULT_WAIT_TIMEOUT_MS),
          );
          const outcome = await deps.waitFor(params.targets, timeoutMs, signal);
          const finalDetails: WaitAgentDetails = {
            ...outcome,
            agents: outcome.agents.map(withDisplayDetails),
            wait_started_at: startedAt,
            wait_ended_at: Date.now(),
            ...(params.timeout_ms === undefined ? {} : { timeout_ms: params.timeout_ms }),
          };
          if (outcome.outcome === "error") return textResult(outcome.message, finalDetails);
          return textResult(
            JSON.stringify({ status: outcome.status, timed_out: outcome.timed_out }),
            finalDetails,
          );
        } finally {
          if (timer) clearInterval(timer);
        }
      },
      renderCall(_args, _theme) {
        return { render: () => [], invalidate() {} };
      },
      renderResult(result, { expanded }, theme) {
        const details = result.details as WaitAgentDetails | undefined;
        if (!details || !Array.isArray(details.agents))
          return { render: () => [], invalidate() {} };
        return renderWaitAgent(details, expanded, theme);
      },
    }),
  );
}
