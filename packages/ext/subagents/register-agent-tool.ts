import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
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
import { type AgentActivity } from "./ui/agent-format.js";
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
          : "general";
        const description = args.description || "no description";
        const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
        const config = getAgentConfig(subagentType);
        const effective = renderMetadata.get(context.toolCallId);
        const model = effective?.model ?? args.model ?? config?.model;
        const thinking = effective?.thinking ?? args.thinking ?? config?.thinking;
        const metadata = [model, thinking && `thinking: ${thinking}`].filter(Boolean).join(" · ");

        return {
          render(width: number): string[] {
            const title =
              theme.fg("toolTitle", theme.bold(subagentType)) +
              theme.fg("dim", `(${description})`) +
              (metadata ? theme.fg("dim", `: ${metadata}`) : "");
            const lines = [truncateToWidth(title, width, "…")];
            const promptWidth = Math.max(1, width - 3);
            const promptLines = prompt
              .split("\n")
              .flatMap((line) => wrapTextWithAnsi(line, promptWidth));
            for (const line of context.expanded ? promptLines : promptLines.slice(0, 3)) {
              lines.push(theme.fg("dim", " │ ") + truncateToWidth(line, promptWidth, "…"));
            }
            if (!context.expanded) lines.push(theme.fg("dim", " (ctrl+o to expand)"));
            return lines;
          },
          invalidate() {},
        };
      },

      renderResult() {
        return new Container();
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
