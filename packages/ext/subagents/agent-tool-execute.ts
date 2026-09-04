import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createActivityTracker } from "./activity-tracker.js";
import type { AgentManager } from "./agent-manager.js";
import { resolveSpawnAgent } from "./agent-types.js";
import { resolveAgentInvocationConfig } from "./invocation-config.js";
import { modelKey, resolveModel } from "./model-resolver.js";
import { textResult } from "./tool-result.js";
import { isThinkingLevel, type AgentInvocation, type ThinkingLevel } from "./types.js";
import {
  type AgentActivity,
  type AgentDetails,
  buildInvocationTags,
  getDisplayName,
} from "./ui/agent-format.js";
import type { FleetList } from "./ui/fleet-list.js";
import { sanitizeText } from "./ui/text-lines.js";
import { getActiveSubagent } from "./subagent-context.js";

type AgentToolParams = {
  message: string;
  agent_type?: string;
  fork_context?: boolean;
  model?: string;
  reasoning_effort?: string;
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
  isScopeModelsEnabled: () => boolean;
  setRenderMetadata?: (toolCallId: string, model: string, thinking: ThinkingLevel) => void;
};

export function createAgentToolExecute(deps: AgentToolExecuteDeps) {
  const { pi, manager, agentActivity, fleet, isScopeModelsEnabled } = deps;
  const parentAgentType = getActiveSubagent();
  return async (
    toolCallId: string,
    params: AgentToolParams,
    _signal: AbortSignal | undefined,
    _onUpdate: AgentToolUpdate | undefined,
    ctx: ExtensionContext,
  ) => {
    if (!params.message.trim()) return failedResult("Empty message can't be sent to an agent.");
    const role = resolveSpawnAgent(params.agent_type, params.fork_context, parentAgentType);
    if ("error" in role) return failedResult(role.error);
    const resolved = role.agent;
    const subagentType = resolved.type;
    const description = deriveDisplayDescription(params.message);
    const displayName = description || getDisplayName(subagentType);
    const agentConfig = resolved.config;
    if (params.reasoning_effort !== undefined && !isThinkingLevel(params.reasoning_effort)) {
      return failedResult(
        `Unsupported reasoning_effort '${params.reasoning_effort}'.`,
        subagentType,
      );
    }
    const resolvedConfig = resolveAgentInvocationConfig(agentConfig, params);

    let model = ctx.model as Model<Api> | undefined;
    if (resolvedConfig.modelInput) {
      const candidate = resolveModel(resolvedConfig.modelInput, ctx.modelRegistry);
      if (typeof candidate === "string") {
        if (resolvedConfig.modelFromParams) return failedResult(candidate, subagentType);
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
          return failedResult(
            `Model not in scope: "${resolvedConfig.modelInput}".\n\n` +
              `Allowed models (from session scope):\n${list}`,
            subagentType,
          );
        }
        const agentLabel = agentConfig.displayName ?? subagentType;
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
    };
    const { tags } = buildInvocationTags(agentInvocation);
    const { state, callbacks } = createActivityTracker();

    let id: string;
    try {
      id = manager.spawn(pi, ctx, subagentType, params.message, {
        description: displayName,
        model,
        thinkingLevel: thinking,
        forkContext: params.fork_context,
        invocation: agentInvocation,
        ...callbacks,
      });
    } catch (error) {
      return failedResult(error instanceof Error ? error.message : String(error), subagentType);
    }

    const record = manager.getRecord(id);
    if (record) record.toolCallId = toolCallId;
    agentActivity.set(id, state);
    fleet.ensureTimer();
    fleet.update();

    const status = record?.status === "queued" ? "queued" : "running";
    return textResult<AgentDetails>(
      JSON.stringify({ agent_id: id, nickname: displayName || null }),
      {
        displayName,
        description: displayName,
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

function failedResult(message: string, subagentType = "default") {
  return textResult<AgentDetails>(message, {
    displayName: subagentType,
    description: "",
    subagentType,
    toolUses: 0,
    tokens: "",
    durationMs: 0,
    status: "error" as const,
    error: message,
  });
}

function deriveDisplayDescription(message: string): string {
  const line = sanitizeText(message)
    .split("\n")
    .find((candidate) => candidate.trim().length > 0)
    ?.trim();
  if (!line) return "";
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}
