import {
  defineTool,
  type AgentToolResult,
  type ExtensionAPI,
  type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { emitSubagentEvent } from "./events.js";
import { getAgentConversation, SUBAGENT_TOOL_NAMES, steerAgent } from "./agent-runner.js";
import { getStatusNote } from "./status-note.js";
import { formatLifetimeTokens, textResult } from "./tool-result.js";
import { type AgentManager } from "./agent-manager.js";
import { formatDuration, type Theme } from "./ui/agent-format.js";
import { getSessionContextPercent } from "./usage.js";

type HelperToolDetails = {
  kind: "get_result" | "steer";
  agentId?: string;
  type?: string;
  status?: string;
  description?: string;
  stats?: string;
  preview?: string;
  state?: string;
};

function renderCompactHelperResult(
  result: AgentToolResult<HelperToolDetails | undefined>,
  options: ToolRenderResultOptions,
  theme: Theme,
) {
  const details = result.details;
  const text = result.content[0]?.type === "text" ? result.content[0].text : "";
  if (!details || options.expanded) return new Text(text, 0, 0);

  return {
    render(width: number): string[] {
      const lineWidth = Math.max(1, width - 3);
      const lines: string[] = [];
      if (details.kind === "get_result") {
        lines.push(
          `${theme.fg("muted", "⎿  ")}${details.agentId ?? "agent"}: ${details.type ?? "?"} | ${details.status ?? "?"}${details.stats ? theme.fg("muted", ` | ${details.stats}`) : ""}`,
        );
        if (details.description)
          lines.push(`   ${truncateToWidth(details.description, lineWidth, "…")}`);
        if (details.preview) lines.push(`   ${truncateToWidth(details.preview, lineWidth, "…")}`);
      } else {
        lines.push(`${theme.fg("muted", "⎿  ")}${details.preview ?? "Steering message sent"}`);
        if (details.state) lines.push(`   ${truncateToWidth(details.state, lineWidth, "…")}`);
      }
      lines.push(`   ${theme.fg("muted", "(ctrl+o to expand)")}`);
      return lines;
    },
    invalidate() {},
  };
}

export function registerResultTools(
  pi: ExtensionAPI,
  manager: AgentManager,
  cancelNudge: (key: string) => void,
  updateHelperToolsActive?: () => void,
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
      renderResult: renderCompactHelperResult,
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
          updateHelperToolsActive?.();
        }

        if (params.verbose && record.session) {
          const conversation = getAgentConversation(record.session);
          if (conversation) output += `\n\n--- Agent Conversation ---\n${conversation}`;
        }

        return textResult(output, {
          kind: "get_result",
          agentId: record.id,
          type: record.type,
          status: record.status,
          description: record.description,
          stats: statsParts.join(" | "),
          preview:
            record.status === "running"
              ? "Agent is still running."
              : (record.result || record.error || "No output.")
                  .trim()
                  .replace(/\s+/g, " ")
                  .slice(0, 160),
        });
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
      renderResult: renderCompactHelperResult,
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
          emitSubagentEvent(pi, "subagents:steered", { id: record.id, message: params.message });
          return textResult(
            `Steering message queued for agent ${record.id}. It will be delivered once the session initializes.`,
            {
              kind: "steer",
              agentId: record.id,
              status: record.status,
              preview: "Steering message queued",
              state: `Current agent state: ${record.status}`,
            },
          );
        }

        try {
          await steerAgent(record.session, params.message);
          emitSubagentEvent(pi, "subagents:steered", { id: record.id, message: params.message });
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
            {
              kind: "steer",
              agentId: record.id,
              status: record.status,
              preview: "Steering message sent",
              state: `Current state: ${stateParts.join(" · ")}`,
            },
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
