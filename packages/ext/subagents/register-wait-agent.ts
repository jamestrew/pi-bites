import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { WaitAgentOutcome } from "./types.js";
import { textResult } from "./tool-result.js";
import { SUBAGENT_TOOL_NAMES } from "./agent-runner.js";

export const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
export const MIN_WAIT_TIMEOUT_MS = 10_000;
export const MAX_WAIT_TIMEOUT_MS = 60 * 60_000;

type WaitAgentDeps = {
  waitFor: (
    agentIds: string[],
    timeoutMs: number,
    signal?: AbortSignal,
  ) => Promise<WaitAgentOutcome>;
};

export function registerWaitAgent(pi: ExtensionAPI, deps: WaitAgentDeps): void {
  pi.registerTool(
    defineTool({
      name: SUBAGENT_TOOL_NAMES.WAIT_AGENT,
      label: "WaitAgent",
      description:
        "Wait for any selected running agent to reach a terminal state. This is event-driven, not polling. " +
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
      async execute(_toolCallId, params, signal) {
        const outcome = await deps.waitFor(
          params.agent_ids,
          params.timeout_ms ?? DEFAULT_WAIT_TIMEOUT_MS,
          signal,
        );
        return textResult(JSON.stringify(outcome, null, 2), outcome);
      },
    }),
  );
}
