import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
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
import { fitLine, sanitizeSingleLine, wrapDisplayLines } from "./ui/text-lines.js";

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

  const renderMetadata = new Map<string, { model?: string; thinking?: string }>();

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
        const description = sanitizeSingleLine(args.description || "no description");
        const prompt = typeof args.prompt === "string" ? args.prompt : "";

        return {
          render(width: number): string[] {
            const config = getAgentConfig(subagentType);
            const effective = renderMetadata.get(context.toolCallId);
            const model = effective?.model ?? args.model ?? config?.model;
            const thinking = effective?.thinking ?? args.thinking ?? config?.thinking;
            const metadata = sanitizeSingleLine([model, thinking].filter(Boolean).join(" "));
            const title =
              theme.fg("toolTitle", theme.bold(sanitizeSingleLine(subagentType))) +
              theme.fg("dim", `(${description})`) +
              (metadata ? theme.fg("dim", `: ${metadata}`) : "");
            const lines = [fitLine(title, width), ""];
            const promptLines = wrapDisplayLines(prompt, Math.max(1, width));
            const visiblePromptLines = context.expanded
              ? promptLines
              : promptLines.slice(0, 3).filter((line) => line.trim().length > 0);
            for (const line of visiblePromptLines) {
              lines.push(fitLine(theme.fg("dim", line), width));
            }
            if (!context.expanded)
              lines.push(fitLine(theme.fg("dim", "(ctrl+o to expand)"), width));
            return lines;
          },
          invalidate() {},
        };
      },

      renderResult(result, _options, _theme, context) {
        const details = result.details;
        const thinking =
          details?.thinking ??
          details?.tags?.find((tag) => tag.startsWith("thinking: "))?.slice("thinking: ".length);
        if (details?.modelName || thinking) {
          renderMetadata.set(context.toolCallId, {
            model: details?.modelName,
            thinking,
          });
        }
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
