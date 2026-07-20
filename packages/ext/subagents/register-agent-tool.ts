import { defineTool, type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AgentManager } from "./agent-manager.js";
import { getAgentToolDescription } from "./agent-tool-description.js";
import { createAgentToolExecute } from "./agent-tool-execute.js";
import { buildDetails } from "./tool-result.js";
import { SUBAGENT_TOOL_NAMES } from "./agent-runner.js";
import { getAgentConfig, getAvailableTypes } from "./agent-types.js";
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
  updateHelperToolsActive?: () => void;
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
    updateHelperToolsActive,
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
      promptGuidelines: [
        [
          "Use Agent with specialized agents when the task matches an agent type's description.",
          "Use general only when the user explicitly requests it, independent work can run in parallel, or delegation has another concrete stated benefit.",
          "Handle ordinary implementation requests directly; complexity alone is not a reason to spawn a blocking foreground general subagent.",
          "Subagents are valuable for parallelizing independent queries or for protecting the main context window from excessive results, but should not be used excessively when not needed.",
          "Importantly, avoid duplicating work that subagents are already doing — if you delegate research to a subagent, do not also perform the same searches yourself.",
        ].join(" "),
        [
          "Start bounded investigations with direct tools (read, grep, find).",
          "If 2-4 targeted tool calls do not locate the answer and broader searching is needed, delegate to Explore and pass along what was already checked.",
          "Delegate immediately only for obviously broad, high-fanout, or context-heavy exploration.",
          "Afterward, read only the files needed to act on or verify the findings.",
        ].join(" "),
        [
          "When an agent runs in the background, you will be notified on completion — do not poll or sleep waiting for it.",
          "Continue with other work instead.",
        ].join(" "),
        [
          "Trust but verify: an agent's summary describes intent, not outcome.",
          "When an agent writes or edits code, check the actual changes before reporting work as done.",
        ].join(" "),
      ],
      parameters: Type.Object({
        // Put render-critical fields first so streamed tool calls don't briefly
        // display as a generic `Agent(...)` before the subagent type arrives.
        subagent_type: Type.String({
          description: `The type of specialized agent to use. Available types: ${getAvailableTypes().join(", ")}. Custom agents from .pi/agents/*.md (project) or ${getAgentDir()}/agents/*.md (global) are also available.`,
        }),
        description: Type.String({
          description: "A short (3-5 word) description of the task (shown in UI).",
        }),
        prompt: Type.String({
          description: "The task for the agent to perform.",
        }),
        model: Type.Optional(
          Type.String({
            description:
              'Optional model override. Accepts "provider/modelId" or fuzzy name (e.g. "haiku", "sonnet"). Omit to use the agent type\'s default.',
          }),
        ),
        thinking: Type.Optional(
          Type.String({
            description:
              "Thinking level: off, minimal, low, medium, high, xhigh, max. Overrides agent default.",
          }),
        ),
        run_in_background: Type.Optional(
          Type.Boolean({
            description:
              "Set to true to run in background. Returns agent ID immediately. You will be notified on completion.",
          }),
        ),
        isolation: Type.Optional(
          Type.Literal("worktree", {
            description:
              'Set to "worktree" to run the agent in a temporary git worktree (isolated copy of the repo). Changes are saved to a branch on completion.',
          }),
        ),
      }),

      // ---- Custom rendering: Claude Code style ----

      renderCall(args, theme, context) {
        const displayName = args.subagent_type ? getDisplayName(args.subagent_type) : "Agent";
        const preview =
          args.description ||
          String(args.prompt).replace(/\s+/g, " ").trim().slice(0, 80) ||
          "no prompt";
        const config = args.subagent_type ? getAgentConfig(args.subagent_type) : undefined;
        const effective = renderMetadata.get(context.toolCallId);
        const model = effective?.model ?? args.model ?? config?.model;
        const thinking = effective?.thinking ?? args.thinking ?? config?.thinking;
        const modelSuffix = [model, thinking && `thinking: ${thinking}`]
          .filter(Boolean)
          .join(" · ");
        const suffixes = [
          modelSuffix || undefined,
          args.run_in_background ? "background" : undefined,
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
        updateHelperToolsActive,
        setRenderMetadata: (toolCallId, model, thinking) =>
          renderMetadata.set(toolCallId, { model, thinking }),
      }),
    }),
  );
}
