import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { AgentManager } from "./agent-manager.js";
import {
  AGENT_PROMPT_GUIDELINES,
  getAgentToolDescription,
  getAgentToolParameters,
} from "./agent-tool-description.js";
import { createAgentToolExecute } from "./agent-tool-execute.js";
import { SUBAGENT_TOOL_NAMES } from "./agent-runner.js";
import { getAgentConfig, resolveType } from "./agent-types.js";
import { applyAndEmitLoaded, type ToolDescriptionMode } from "./settings.js";
import { buildDetails } from "./tool-result.js";
import type { AgentRecord } from "./types.js";
import { type AgentActivity, getDisplayName } from "./ui/agent-format.js";
import { renderAgentToolResult } from "./ui/agent-tool-render.js";
import type { FleetList } from "./ui/fleet-list.js";

type RegisterAgentToolDeps = {
  manager: AgentManager;
  agentActivity: Map<string, AgentActivity>;
  fleet: FleetList;
  reloadCustomAgents: () => void;
  isScopeModelsEnabled: () => boolean;
  getToolDescriptionMode: () => ToolDescriptionMode;
  setScopeModelsEnabled: (enabled: boolean) => void;
  setDisableDefaultAgents: (disabled: boolean) => void;
  setToolDescriptionMode: (mode: ToolDescriptionMode) => void;
  setFleetViewEnabled: (enabled: boolean) => void;
};

export function registerAgentTool(pi: ExtensionAPI, deps: RegisterAgentToolDeps) {
  const terminalRecords = new Map<string, AgentRecord>();
  const rememberTerminalRecord = (event: { id: string }) => {
    if (!event.id) return;
    const record = deps.manager.getRecord(event.id);
    if (record) terminalRecords.set(event.id, record);
  };
  pi.events.on("subagents:completed", (data) => rememberTerminalRecord(data as { id: string }));
  pi.events.on("subagents:failed", (data) => rememberTerminalRecord(data as { id: string }));

  applyAndEmitLoaded(
    {
      setMaxConcurrent: (n) => deps.manager.setMaxConcurrent(n),
      setScopeModels: deps.setScopeModelsEnabled,
      setDisableDefaultAgents: deps.setDisableDefaultAgents,
      setToolDescriptionMode: deps.setToolDescriptionMode,
      setFleetView: deps.setFleetViewEnabled,
    },
    (event, payload) => pi.events.emit(event, payload),
  );

  const renderMetadata = new Map<string, { model: string; thinking: string }>();

  pi.registerTool(
    defineTool({
      name: SUBAGENT_TOOL_NAMES.AGENT,
      label: "Agent",
      description: getAgentToolDescription(deps.getToolDescriptionMode()),
      promptSnippet: "Launch autonomous sub-agents when delegation has a concrete benefit",
      promptGuidelines: AGENT_PROMPT_GUIDELINES,
      parameters: getAgentToolParameters(),

      renderCall(args, theme, context) {
        const subagentType = args.subagent_type
          ? (resolveType(args.subagent_type) ?? "general")
          : undefined;
        const displayName = subagentType ? getDisplayName(subagentType) : "Agent";
        const preview =
          args.description ||
          String(args.prompt).replace(/\s+/g, " ").trim().slice(0, 80) ||
          "no prompt";
        const config = subagentType ? getAgentConfig(subagentType) : undefined;
        const effective = renderMetadata.get(context.toolCallId);
        const model = effective?.model ?? args.model ?? config?.model;
        const thinking = effective?.thinking ?? args.thinking ?? config?.thinking;
        const metadata = [model, thinking && `thinking: ${thinking}`].filter(Boolean).join(" · ");
        const suffix = metadata ? theme.fg("dim", `: ${metadata}`) : "";
        return new Text(
          theme.fg("toolTitle", theme.bold(displayName)) + theme.fg("dim", `(${preview})`) + suffix,
          0,
          0,
        );
      },

      renderResult(result, options, theme, context) {
        const details = result.details;
        const record = details?.agentId
          ? (terminalRecords.get(details.agentId) ?? deps.manager.getRecord(details.agentId))
          : undefined;
        const currentResult =
          details && record && ["completed", "error", "stopped"].includes(record.status)
            ? {
                ...result,
                details: buildDetails(details, record, deps.agentActivity.get(record.id)),
              }
            : result;
        return renderAgentToolResult(currentResult, options, theme, context);
      },
      execute: createAgentToolExecute({
        pi,
        manager: deps.manager,
        agentActivity: deps.agentActivity,
        fleet: deps.fleet,
        reloadCustomAgents: deps.reloadCustomAgents,
        isScopeModelsEnabled: deps.isScopeModelsEnabled,
        setRenderMetadata: (toolCallId, model, thinking) =>
          renderMetadata.set(toolCallId, { model, thinking }),
      }),
    }),
  );
}
