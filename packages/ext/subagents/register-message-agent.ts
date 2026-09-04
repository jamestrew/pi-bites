import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type AgentManager } from "./agent-manager.js";
import { SUBAGENT_TOOL_NAMES, steerAgent } from "./agent-runner.js";
import { textResult } from "./tool-result.js";
import {
  renderMessageAgentCall,
  renderMessageAgentResult,
  type MessageAgentStatus,
} from "./ui/message-agent-render.js";

type MessageAgentDetails = {
  status: MessageAgentStatus;
  recipient: string;
  message: string;
};

type MessageAgentRenderState = { recipient?: string };

export function registerMessageAgent(pi: ExtensionAPI, manager: AgentManager) {
  pi.registerTool(
    defineTool({
      name: SUBAGENT_TOOL_NAMES.MESSAGE_AGENT,
      label: "MessageAgent",
      description:
        "Send a message to a running agent. The agent receives it after its current assistant response's tool-call batch. " +
        "Messages are queued while the agent session initializes. Use it to provide behavior-changing context or ask a " +
        "question requiring a decision. A status check is appropriate when its reply informs a current decision. Do not use it to hurry an agent or cut a review short. Request wrap-up only when " +
        "the task is independently no longer needed, never merely because a WaitAgent timed out or the agent seems slow. " +
        "A wrap-up request does not confirm the agent stopped; only terminal status does. Completed agents cannot be resumed.",
      promptSnippet: "Send a message to a running agent",
      parameters: Type.Object(
        {
          agent_id: Type.String({ description: "The running agent's identifier." }),
          message: Type.String({ description: "The message to send to the agent." }),
        },
        { additionalProperties: false },
      ),
      renderCall({ agent_id, message }, theme, context) {
        const state = context.state as MessageAgentRenderState;
        state.recipient ??= manager.getRecord(agent_id)?.description ?? agent_id;
        return {
          render: (width: number) =>
            renderMessageAgentCall(state.recipient ?? agent_id, message, theme).render(width),
          invalidate() {},
        };
      },
      renderResult(result, _options, theme, context) {
        const details = result.details as MessageAgentDetails | undefined;
        const state = context.state as MessageAgentRenderState;
        if (details?.recipient) state.recipient = details.recipient;
        return renderMessageAgentResult(details?.status ?? "failed", theme);
      },
      execute: async (_toolCallId, params) => {
        const record = manager.getRecord(params.agent_id);
        const recipient = record?.description ?? params.agent_id;
        const result = (text: string, status: MessageAgentStatus) =>
          textResult<MessageAgentDetails>(text, { status, recipient, message: params.message });

        if (!record) {
          return result(
            `Agent not found: "${params.agent_id}". It may have been cleaned up.`,
            "failed",
          );
        }
        if (record.status !== "running" && record.status !== "queued") {
          return result(
            `Agent "${params.agent_id}" is not running (status: ${record.status}). Cannot message a non-running agent.`,
            "failed",
          );
        }
        if (record.status === "queued" || !record.session) {
          if (!manager.steer(record.id, params.message)) {
            return result(`Failed to queue message for agent ${record.id}.`, "failed");
          }
          pi.events.emit("subagents:steered", { id: record.id, message: params.message });
          return result(
            `Message queued for agent ${record.id}. It will be delivered once the session initializes.`,
            "queued",
          );
        }

        try {
          await steerAgent(record.session, params.message);
          pi.events.emit("subagents:steered", { id: record.id, message: params.message });
          return result(
            `Message sent to agent ${record.id}. The agent will process it after its current assistant response's tool-call batch.`,
            "sent",
          );
        } catch (err) {
          return result(
            `Failed to message agent: ${err instanceof Error ? err.message : String(err)}`,
            "failed",
          );
        }
      },
    }),
  );
}
