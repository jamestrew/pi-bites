import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type AgentManager } from "./agent-manager.js";
import {
  AGENT_PROMPT_GUIDELINES,
  getAgentToolDescription,
  getAgentToolParameters,
} from "./agent-tool-description.js";
import { createAgentToolExecute } from "./agent-tool-execute.js";
import { buildDetails } from "./tool-result.js";
import { SUBAGENT_TOOL_NAMES } from "./agent-runner.js";
import { getAgentConfig, resolveType } from "./agent-types.js";
import { resolveRunInBackground } from "./invocation-config.js";
import { applyAndEmitLoaded, type ToolDescriptionMode } from "./settings.js";
import { type AgentRecord, type JoinMode } from "./types.js";
import { type AgentActivity, getDisplayName } from "./ui/agent-format.js";
import { type FleetList } from "./ui/fleet-list.js";
import { renderAgentToolResult } from "./ui/agent-tool-render.js";

type RegisterAgentToolDeps = {
  manager: AgentManager;
  agentActivity: Map<string, AgentActivity>;
  fleet: FleetList;
  reloadCustomAgents: () => void;
  isScopeModelsEnabled: () => boolean;
  getToolDescriptionMode: () => ToolDescriptionMode;
  setDefaultJoinMode: (mode: JoinMode) => void;
  setScopeModelsEnabled: (enabled: boolean) => void;
  setDisableDefaultAgents: (disabled: boolean) => void;
  setToolDescriptionMode: (mode: ToolDescriptionMode) => void;
  setFleetViewEnabled: (enabled: boolean) => void;
  getDefaultJoinMode: () => JoinMode;
  trackSpawned: (id: string, joinMode: JoinMode) => void;
};

export function registerAgentTool(pi: ExtensionAPI, deps: RegisterAgentToolDeps) {
  const {
    manager,
    agentActivity,
    fleet,
    reloadCustomAgents,
    isScopeModelsEnabled,
    getToolDescriptionMode,
    setDefaultJoinMode,
    setScopeModelsEnabled,
    setDisableDefaultAgents,
    setToolDescriptionMode,
    setFleetViewEnabled,
    getDefaultJoinMode,
    trackSpawned,
  } = deps;
  const terminalRecords = new Map<string, AgentRecord>();
  const rememberTerminalRecord = (event: { id: string }) => {
    const { id } = event;
    if (!id) return;
    const record = manager.getRecord(id);
    if (record) terminalRecords.set(id, record);
  };
  pi.events.on("subagents:completed", (data) => rememberTerminalRecord(data as { id: string }));
  pi.events.on("subagents:failed", (data) => rememberTerminalRecord(data as { id: string }));

  applyAndEmitLoaded(
    {
      setMaxConcurrent: (n) => manager.setMaxConcurrent(n),
      setDefaultJoinMode,
      setScopeModels: setScopeModelsEnabled,
      setDisableDefaultAgents,
      setToolDescriptionMode,
      setFleetView: setFleetViewEnabled,
    },
    (event, payload) => pi.events.emit(event, payload),
  );

  const renderMetadata = new Map<string, { model: string; thinking: string }>();

  pi.registerTool(
    defineTool({
      name: SUBAGENT_TOOL_NAMES.AGENT,
      label: "Agent",
      description: getAgentToolDescription(getToolDescriptionMode()),
      promptSnippet: "Launch autonomous sub-agents when delegation has a concrete benefit",
      promptGuidelines: AGENT_PROMPT_GUIDELINES,
      parameters: getAgentToolParameters(),
      constrainedSampling: { type: "json_schema", strict: "prefer" },

      // ---- Custom rendering: Claude Code style ----

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
        const modelSuffix = [model, thinking && `thinking: ${thinking}`]
          .filter(Boolean)
          .join(" · ");
        const suffixes = [
          modelSuffix || undefined,
          resolveRunInBackground(config, args.run_in_background) ? "background" : undefined,
        ]
          .filter(Boolean)
          .map((s) => theme.fg("dim", `: ${s}`))
          .join("");
        return new Text(
          theme.fg("toolTitle", theme.bold(displayName)) +
            theme.fg("dim", `(${preview})`) +
            suffixes,
          0,
          0,
        );
      },

      renderResult(result, options, theme, context) {
        const details = result.details;
        const record = details?.agentId
          ? (terminalRecords.get(details.agentId) ?? manager.getRecord(details.agentId))
          : undefined;
        const currentResult =
          details && record && ["completed", "error", "stopped"].includes(record.status)
            ? {
                ...result,
                details: buildDetails(details, record, agentActivity.get(record.id)),
              }
            : result;
        return renderAgentToolResult(currentResult, options, theme, context);
      },
      execute: createAgentToolExecute({
        pi,
        manager,
        agentActivity,
        fleet,
        reloadCustomAgents,
        isScopeModelsEnabled,
        getDefaultJoinMode,
        trackSpawned,
        setRenderMetadata: (toolCallId, model, thinking) =>
          renderMetadata.set(toolCallId, { model, thinking }),
      }),
    }),
  );
}
