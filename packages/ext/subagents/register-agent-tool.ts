import { defineTool, type ExtensionAPI, keyHint } from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import type { AgentManager } from "./agent-manager.js";
import { getAgentToolParameters } from "./agent-tool-description.js";
import { createAgentToolExecute } from "./agent-tool-execute.js";
import { CODEX_V1_CONTRACT } from "./codex-v1-contract.js";
import { SUBAGENT_TOOL_NAMES } from "./agent-runner.js";
import { resolveAgent, resolveSpawnAgent } from "./agent-types.js";
import { applyAndEmitLoaded } from "./settings.js";
import { type AgentActivity } from "./ui/agent-format.js";
import type { FleetList } from "./ui/fleet-list.js";
import { fitLine, sanitizeSingleLine, wrapDisplayLines } from "./ui/text-lines.js";
import { getActiveSubagent } from "./subagent-context.js";

type RegisterAgentToolDeps = {
  manager: AgentManager;
  agentActivity: Map<string, AgentActivity>;
  fleet: FleetList;
  isScopeModelsEnabled: () => boolean;
  setScopeModelsEnabled: (enabled: boolean) => void;
  setFleetViewEnabled: (enabled: boolean) => void;
};

export function registerAgentTool(pi: ExtensionAPI, deps: RegisterAgentToolDeps) {
  applyAndEmitLoaded(
    {
      setMaxConcurrent: (n) => deps.manager.setMaxConcurrent(n),
      setScopeModels: deps.setScopeModelsEnabled,
      setFleetView: deps.setFleetViewEnabled,
    },
    (event, payload) => pi.events.emit(event, payload),
  );

  const parentAgentType = getActiveSubagent();
  const renderMetadata = new Map<
    string,
    { model?: string; thinking?: string; subagentType?: string; error?: string }
  >();

  pi.registerTool(
    defineTool({
      name: SUBAGENT_TOOL_NAMES.SPAWN_AGENT,
      label: "spawn_agent",
      description: CODEX_V1_CONTRACT.tools.spawn_agent.description,
      parameters: getAgentToolParameters(),

      renderCall(args, theme, context) {
        const role = resolveSpawnAgent(args.agent_type, args.fork_context, parentAgentType);
        const initialType =
          ("agent" in role ? role.agent.type : undefined) ?? args.agent_type?.trim() ?? "default";
        const prompt = typeof args.message === "string" ? args.message : "";

        return {
          render(width: number): string[] {
            const effective = renderMetadata.get(context.toolCallId);
            const subagentType = effective?.subagentType ?? initialType;
            const config = resolveAgent(subagentType).config;
            const model = effective?.model ?? args.model ?? config.model;
            const thinking = effective?.thinking ?? args.reasoning_effort ?? config.thinking;
            const metadata = sanitizeSingleLine([model, thinking].filter(Boolean).join(" "));
            const title =
              theme.bold("spawn_agent") +
              theme.fg(
                "accent",
                ` ${sanitizeSingleLine(subagentType)}${metadata ? `: ${metadata}` : ""}`,
              );
            const lines = [fitLine(title, width), ""];
            const promptLines = wrapDisplayLines(prompt, Math.max(1, width));
            const visiblePromptLines = context.expanded
              ? promptLines
              : promptLines.slice(0, 3).filter((line) => line.trim().length > 0);
            for (const line of visiblePromptLines) {
              lines.push(fitLine(theme.fg("dim", line), width));
            }
            if (!context.expanded && promptLines.slice(3).some((line) => line.trim().length > 0))
              lines.push(fitLine(theme.fg("dim", `(${expandHint()})`), width));
            if (effective?.error) {
              lines.push("", fitLine(theme.fg("dim", `Error: ${effective.error}`), width));
            }
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
        if (details?.modelName || thinking || details?.subagentType || details?.error) {
          renderMetadata.set(context.toolCallId, {
            model: details?.modelName,
            thinking,
            subagentType: details?.subagentType,
            error: details?.error,
          });
        }
        return new Container();
      },
      execute: createAgentToolExecute({
        pi,
        manager: deps.manager,
        agentActivity: deps.agentActivity,
        fleet: deps.fleet,
        isScopeModelsEnabled: deps.isScopeModelsEnabled,
        setRenderMetadata: (toolCallId, model, thinking) =>
          renderMetadata.set(toolCallId, { model, thinking }),
      }),
    }),
  );
}

function expandHint(): string {
  try {
    return keyHint("app.tools.expand", "to expand");
  } catch {
    // Print-mode renderers do not initialize interactive keybindings or themes.
    return "ctrl+o to expand";
  }
}
