import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getAgentConversation, SUBAGENT_TOOL_NAMES, steerAgent } from "./agent-runner.js";
import { getStatusNote } from "./status-note.js";
import { textResult, formatLifetimeTokens } from "./tool-result.js";
import { type AgentManager } from "./agent-manager.js";
import { formatDuration } from "./ui/agent-widget.js";
import { getSessionContextPercent } from "./usage.js";

export function registerResultTools(
  pi: ExtensionAPI,
  manager: AgentManager,
  cancelNudge: (key: string) => void,
) {
  pi.registerTool(
    defineTool({
      name: SUBAGENT_TOOL_NAMES.GET_RESULT,
      label: "Get Agent Result",
      description:
        "Check status and retrieve results from a background agent. Use the agent ID returned by Agent with run_in_background.",
      promptSnippet: "Check status and retrieve results from a background agent",
      parameters: Type.Object({
        agent_id: Type.String({ description: "The agent ID to check." }),
        wait: Type.Optional(
          Type.Boolean({
            description:
              "If true, wait for the agent to complete before returning. Default: false.",
          }),
        ),
        verbose: Type.Optional(
          Type.Boolean({
            description:
              "If true, include the agent's full conversation (messages + tool calls). Default: false.",
          }),
        ),
      }),
      execute: async (_toolCallId, params) => {
        const record = manager.getRecord(params.agent_id);
        if (!record) {
          return textResult(`Agent not found: "${params.agent_id}". It may have been cleaned up.`);
        }

        if (params.wait && record.status === "running" && record.promise) {
          record.resultConsumed = true;
          cancelNudge(params.agent_id);
          await record.promise;
        }

        const duration = formatDuration(record.startedAt, record.completedAt);
        const tokens = formatLifetimeTokens(record);
        const contextPercent = getSessionContextPercent(record.session);
        const statsParts = [`Tool uses: ${record.toolUses}`];
        if (tokens) statsParts.push(tokens);
        if (contextPercent !== null) statsParts.push(`Context: ${Math.round(contextPercent)}%`);
        if (record.compactionCount) statsParts.push(`Compactions: ${record.compactionCount}`);
        statsParts.push(`Duration: ${duration}`);

        let output =
          `Agent: ${record.id}\n` +
          `Type: ${record.type} | Status: ${record.status}${getStatusNote(record.status)} | ${statsParts.join(" | ")}\n` +
          `Description: ${record.description}\n\n`;

        if (record.status === "running") {
          output += "Agent is still running. Use wait: true or check back later.";
        } else if (record.status === "error") {
          output += `Error: ${record.error}`;
        } else {
          output += record.result?.trim() || "No output.";
        }

        if (record.status !== "running" && record.status !== "queued") {
          record.resultConsumed = true;
          cancelNudge(params.agent_id);
        }

        if (params.verbose && record.session) {
          const conversation = getAgentConversation(record.session);
          if (conversation) output += `\n\n--- Agent Conversation ---\n${conversation}`;
        }

        return textResult(output);
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: SUBAGENT_TOOL_NAMES.STEER,
      label: "Steer Agent",
      description:
        "Send a steering message to a running agent. The message will interrupt the agent after its current tool execution " +
        "and be injected into its conversation, allowing you to redirect its work mid-run. Only works on running agents.",
      promptSnippet: "Send a steering message to redirect a running background agent",
      parameters: Type.Object({
        agent_id: Type.String({
          description: "The agent ID to steer (must be currently running).",
        }),
        message: Type.String({
          description:
            "The steering message to send. This will appear as a user message in its conversation.",
        }),
      }),
      execute: async (_toolCallId, params) => {
        const record = manager.getRecord(params.agent_id);
        if (!record) {
          return textResult(`Agent not found: "${params.agent_id}". It may have been cleaned up.`);
        }
        if (record.status !== "running") {
          return textResult(
            `Agent "${params.agent_id}" is not running (status: ${record.status}). Cannot steer a non-running agent.`,
          );
        }
        if (!record.session) {
          if (!record.pendingSteers) record.pendingSteers = [];
          record.pendingSteers.push(params.message);
          pi.events.emit("subagents:steered", { id: record.id, message: params.message });
          return textResult(
            `Steering message queued for agent ${record.id}. It will be delivered once the session initializes.`,
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
            `Steering message sent to agent ${record.id}. The agent will process it after its current tool execution.\n` +
              `Current state: ${stateParts.join(" · ")}`,
          );
        } catch (err) {
          return textResult(
            `Failed to steer agent: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
    }),
  );
}
