import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createActivityTracker } from "./activity-tracker.js";
import type { AgentManager } from "./agent-manager.js";
import { getAgentConfig, resolveType } from "./agent-types.js";
import { resolveAgentInvocationConfig } from "./invocation-config.js";
import { modelKey, resolveModel } from "./model-resolver.js";
import { textResult } from "./tool-result.js";
import type { AgentInvocation, SubagentType, ThinkingLevel } from "./types.js";
import {
  type AgentActivity,
  type AgentDetails,
  buildInvocationTags,
  getDisplayName,
} from "./ui/agent-format.js";
import type { FleetList } from "./ui/fleet-list.js";

type AgentToolParams = {
  subagent_type: string;
  description: string;
  prompt: string;
  model?: string;
  thinking?: string;
  isolated?: boolean;
};

type AgentToolUpdate = (update: {
  content: Array<{ type: "text"; text: string }>;
  details: AgentDetails;
}) => void;

type AgentToolExecuteDeps = {
  pi: ExtensionAPI;
  manager: AgentManager;
  agentActivity: Map<string, AgentActivity>;
  fleet: FleetList;
  reloadCustomAgents: () => void;
  isScopeModelsEnabled: () => boolean;
  setRenderMetadata?: (toolCallId: string, model: string, thinking: ThinkingLevel) => void;
};

export function createAgentToolExecute(deps: AgentToolExecuteDeps) {
  const { pi, manager, agentActivity, fleet, reloadCustomAgents, isScopeModelsEnabled } = deps;
  return async (
    toolCallId: string,
    params: AgentToolParams,
    _signal: AbortSignal | undefined,
    _onUpdate: AgentToolUpdate | undefined,
    ctx: ExtensionContext,
  ) => {
    reloadCustomAgents();

    const rawType = params.subagent_type as SubagentType;
    const resolved = resolveType(rawType);
    const subagentType = resolved ?? "general";
    const displayName = getDisplayName(subagentType);
    const customConfig = getAgentConfig(subagentType);
    const resolvedConfig = resolveAgentInvocationConfig(customConfig, params);

    let model = ctx.model as Model<Api> | undefined;
    if (resolvedConfig.modelInput) {
      const candidate = resolveModel(resolvedConfig.modelInput, ctx.modelRegistry);
      if (typeof candidate === "string") {
        if (resolvedConfig.modelFromParams) return textResult(candidate);
      } else {
        model = candidate;
      }
    }

    if (isScopeModelsEnabled() && model) {
      const allowed = new Set(ctx.scopedModels.map(({ model }) => modelKey(model)));
      if (allowed.size > 0 && !allowed.has(modelKey(model))) {
        if (resolvedConfig.modelFromParams) {
          const list = [...allowed]
            .sort()
            .map((name) => `  ${name}`)
            .join("\n");
          return textResult(
            `Model not in scope: "${resolvedConfig.modelInput}".\n\n` +
              `Allowed models (from session scope):\n${list}`,
          );
        }
        const agentLabel = customConfig?.displayName ?? subagentType;
        const modelLabel = resolvedConfig.modelInput ?? `${model.provider}/${model.id}`;
        ctx.ui.notify(`Agent "${agentLabel}" using out-of-scope model "${modelLabel}"`, "warning");
      }
    }

    const thinking: ThinkingLevel =
      model?.reasoning === false ? "off" : (resolvedConfig.thinking ?? pi.getThinkingLevel());
    if (model) deps.setRenderMetadata?.(toolCallId, `${model.provider}/${model.id}`, thinking);

    const agentInvocation: AgentInvocation = {
      modelName: model ? `${model.provider}/${model.id}` : undefined,
      thinking,
      isolated: resolvedConfig.isolated,
    };
    const { tags } = buildInvocationTags(agentInvocation);
    const { state, callbacks } = createActivityTracker();

    let id: string;
    try {
      id = manager.spawn(pi, ctx, subagentType, params.prompt, {
        description: params.description,
        model,
        isolated: resolvedConfig.isolated,
        thinkingLevel: thinking,
        invocation: agentInvocation,
        ...callbacks,
      });
    } catch (error) {
      return textResult(error instanceof Error ? error.message : String(error));
    }

    const record = manager.getRecord(id);
    if (record) record.toolCallId = toolCallId;
    agentActivity.set(id, state);
    fleet.ensureTimer();
    fleet.update();

    const status = record?.status === "queued" ? "queued" : "running";
    const fallbackNote = resolved ? "" : `Note: Unknown agent type "${rawType}" — using general.\n`;
    return textResult(
      `${fallbackNote}Agent ${status === "queued" ? "queued" : "started"}.\n` +
        `Agent ID: ${id}\n` +
        `Type: ${displayName}\n` +
        `Description: ${params.description}\n` +
        (status === "queued"
          ? `Position: queued (max ${manager.getMaxConcurrent()} concurrent)\n`
          : "") +
        "\nDo not duplicate its assigned work while it runs. Use WaitAgent only when this result blocks progress; " +
        "otherwise continue only non-overlapping work or respond. " +
        "Unconsumed results are delivered automatically.\n" +
        "Use MessageAgent for new context, decisions, or decision-relevant status—not deadline pressure. Do not poll or sleep.",
      {
        displayName,
        description: params.description,
        subagentType,
        modelName: agentInvocation.modelName,
        thinking,
        tags: tags.length > 0 ? tags : undefined,
        toolUses: 0,
        tokens: "",
        durationMs: 0,
        status,
        agentId: id,
      },
    );
  };
}
