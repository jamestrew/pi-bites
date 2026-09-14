import { defineSubagentTool } from "./operation-context.js";
import { Container } from "@earendil-works/pi-tui";
import type { AgentManager } from "./agent-manager.js";
import { getCloseAgentToolParameters } from "./agent-tool-description.js";
import { SUBAGENT_TOOL_NAMES } from "./agent-runner.js";
import { CODEX_V1_CONTRACT } from "./codex-v1-contract.js";
import { v1Result } from "./tool-result.js";
import type { WaitAgentStatus } from "./types.js";
import { lifecycleStatusLabel, renderAgentLifecycle } from "./ui/agent-lifecycle-render.js";

type CloseAgentDetails = {
  target?: string;
  recipient?: string;
  status?: "closed" | "failed";
  previousStatus?: WaitAgentStatus;
  error?: string;
};

export function createCloseAgent(manager: AgentManager) {
  return defineSubagentTool({
    name: SUBAGENT_TOOL_NAMES.CLOSE_AGENT,
    label: "close_agent",
    description: CODEX_V1_CONTRACT.tools.close_agent.description,
    parameters: getCloseAgentToolParameters(),
    renderCall({ target }, theme, context) {
      const state = context.state as CloseAgentDetails;
      if (target && state.target !== target) {
        state.target = target;
        state.recipient = manager.getRecord(target)?.description ?? target;
      }
      return renderAgentLifecycle(
        "close_agent",
        () => ({
          metadata: [
            state.recipient,
            state.status,
            state.previousStatus === undefined
              ? undefined
              : `was ${lifecycleStatusLabel(state.previousStatus, "queued")}`,
          ],
          error: state.error,
        }),
        context.expanded,
        theme,
      );
    },
    renderResult(result, _options, _theme, context) {
      const details = result.details as CloseAgentDetails | undefined;
      if (details) Object.assign(context.state, details);
      if (context.isError) {
        Object.assign(context.state, {
          status: "failed",
          error: result.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("\n"),
        });
      }
      return new Container();
    },
    async execute(_toolCallId, { target }, signal) {
      signal?.throwIfAborted();
      const recipient = manager.getRecord(target)?.description ?? target;
      const previousStatus = await manager.close(target);
      return v1Result<CloseAgentDetails>(
        { previous_status: previousStatus },
        {
          target,
          recipient,
          status: "closed",
          previousStatus,
        },
      );
    },
  });
}
