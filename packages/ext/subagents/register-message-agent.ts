import {
  defineTool,
  type AgentToolResult,
  type ExtensionAPI,
  type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { SUBAGENT_TOOL_NAMES, steerAgent } from "./agent-runner.js";
import { formatLifetimeTokens, textResult } from "./tool-result.js";
import { type AgentManager } from "./agent-manager.js";
import { type Theme } from "./ui/agent-format.js";
import { getSessionContextPercent } from "./usage.js";

type MessageAgentDetails = {
  kind: "message";
  agentId?: string;
  status?: string;
  preview?: string;
  state?: string;
};

function renderCompactMessageResult(
  result: AgentToolResult<MessageAgentDetails | undefined>,
  options: ToolRenderResultOptions,
  theme: Theme,
) {
  const details = result.details;
  const text = result.content[0]?.type === "text" ? result.content[0].text : "";
  if (!details || options.expanded) return new Text(text, 0, 0);

  return {
    render(width: number): string[] {
      const lineWidth = Math.max(1, width - 3);
      const lines = [`${theme.fg("muted", "⎿  ")}${details.preview ?? "Message sent"}`];
      if (details.state) lines.push(`   ${truncateToWidth(details.state, lineWidth, "…")}`);
      lines.push(`   ${theme.fg("muted", "(ctrl+o to expand)")}`);
      return lines;
    },
    invalidate() {},
  };
}

export function registerMessageAgent(pi: ExtensionAPI, manager: AgentManager) {
  pi.registerTool(
    defineTool({
      name: SUBAGENT_TOOL_NAMES.MESSAGE_AGENT,
      label: "Message Agent",
      description:
        "Send a message to a running agent. The agent receives it after its current tool execution. " +
        "Messages are queued while the agent session initializes. Completed agents cannot be resumed.",
      promptSnippet: "Send a message to a running agent",
      parameters: Type.Object({
        agent_id: Type.String({
          description: "The running agent's identifier.",
        }),
        message: Type.String({
          description: "The message to send to the agent.",
        }),
      }),
      renderResult: renderCompactMessageResult,
      execute: async (_toolCallId, params) => {
        const record = manager.getRecord(params.agent_id);
        if (!record) {
          return textResult(`Agent not found: "${params.agent_id}". It may have been cleaned up.`);
        }
        if (record.status !== "running" && record.status !== "queued") {
          return textResult(
            `Agent "${params.agent_id}" is not running (status: ${record.status}). Cannot message a non-running agent.`,
          );
        }
        if (!record.session) {
          if (!record.pendingSteers) record.pendingSteers = [];
          record.pendingSteers.push(params.message);
          pi.events.emit("subagents:steered", { id: record.id, message: params.message });
          return textResult(
            `Message queued for agent ${record.id}. It will be delivered once the session initializes.`,
            {
              kind: "message",
              agentId: record.id,
              status: record.status,
              preview: "Message queued",
              state: `Current agent state: ${record.status}`,
            },
          );
        }

        try {
          await steerAgent(record.session, params.message);
          pi.events.emit("subagents:steered", { id: record.id, message: params.message });
          const tokens = formatLifetimeTokens(record);
          const contextPercent = getSessionContextPercent(record.session);
          const stateParts: string[] = [];
          if (tokens) stateParts.push(tokens);
          stateParts.push(`${record.toolUses} tool ${record.toolUses === 1 ? "use" : "uses"}`);
          if (contextPercent !== null)
            stateParts.push(`context ${Math.round(contextPercent)}% full`);
          if (record.compactionCount)
            stateParts.push(
              `${record.compactionCount} compaction${record.compactionCount === 1 ? "" : "s"}`,
            );
          return textResult(
            `Message sent to agent ${record.id}. The agent will process it after its current tool execution.\n` +
              `Current state: ${stateParts.join(" · ")}`,
            {
              kind: "message",
              agentId: record.id,
              status: record.status,
              preview: "Message sent",
              state: `Current state: ${stateParts.join(" · ")}`,
            },
          );
        } catch (err) {
          return textResult(
            `Failed to message agent: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
    }),
  );
}
