import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { buildWaitAgentResult } from "./agent-completion.js";
import { SUBAGENT_TOOL_NAMES } from "./agent-runner.js";
import { textResult } from "./tool-result.js";
import type { AgentRecord, WaitAgentDetails, WaitAgentOutcome, WaitAgentResult } from "./types.js";
import { renderWaitAgent } from "./ui/wait-agent-render.js";

export const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
export const MIN_WAIT_TIMEOUT_MS = 10_000;
export const MAX_WAIT_TIMEOUT_MS = 4 * 60_000;

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
      label: "WaitAgent",
      description:
        "Wait for any selected running agent to send a message or reach a terminal state. This is event-driven, not polling. " +
        "A timeout returns current statuses without cancelling agents. Wait only when their findings block progress.",
      promptSnippet: "Wait for selected subagents only when their results block progress",
      promptGuidelines: [
        "Use WaitAgent only when selected subagent results are required before continuing; do useful independent work instead when possible.",
        "Do not repeatedly call WaitAgent with short timeouts, poll agent status, or sleep with shell commands.",
      ],
      parameters: Type.Object(
        {
          agent_ids: Type.Array(Type.String(), {
            minItems: 1,
            maxItems: 64,
            uniqueItems: true,
            description: "Stable agent identities returned by Agent.",
          }),
          timeout_ms: Type.Optional(
            Type.Integer({
              minimum: MIN_WAIT_TIMEOUT_MS,
              maximum: MAX_WAIT_TIMEOUT_MS,
              description: `Bounded wait in milliseconds. Defaults to ${DEFAULT_WAIT_TIMEOUT_MS}. Does not cancel agents.`,
            }),
          ),
        },
        { additionalProperties: false },
      ),
      async execute(_toolCallId, params, signal, onUpdate) {
        const startedAt = Date.now();
        const details = (): WaitAgentDetails => ({
          outcome: "waiting",
          timed_out: false,
          agents: params.agent_ids
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
          const outcome = await deps.waitFor(
            params.agent_ids,
            params.timeout_ms ?? DEFAULT_WAIT_TIMEOUT_MS,
            signal,
          );
          const finalDetails: WaitAgentDetails = {
            ...outcome,
            agents: outcome.agents.map(withDisplayDetails),
            wait_started_at: startedAt,
            wait_ended_at: Date.now(),
            ...(params.timeout_ms === undefined ? {} : { timeout_ms: params.timeout_ms }),
          };
          const modelOutcome =
            outcome.outcome === "message"
              ? {
                  ...outcome,
                  sender: {
                    id: outcome.sender.id,
                    type: outcome.sender.type,
                    title: outcome.sender.title,
                  },
                }
              : outcome;
          return textResult(JSON.stringify(modelOutcome, null, 2), finalDetails);
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
