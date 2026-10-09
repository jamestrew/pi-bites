import type { SubagentsSettings } from "./settings.js";
import type { SubagentContext } from "./operation-context.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createActivityTracker } from "./activity-tracker.js";
import type { AgentManager } from "./agent-manager.js";
import { type ResolvedAgent } from "./agent-types.js";
import { resolveAgentInvocationConfig } from "./invocation-config.js";
import { SubagentOperationError } from "./tool-result.js";
import { type AgentInvocation, type SpawnOptions, type SubagentType } from "./types.js";
import {
  type AgentActivity,
  type AgentDetails,
  buildInvocationTags,
  getDisplayName,
} from "./ui/agent-format.js";
import type { FleetList } from "./ui/fleet-list.js";
import { sanitizeText } from "../shared/terminal-text.js";

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
  getModelDefaults?: () => Pick<SubagentsSettings, "defaultModel" | "defaultReasoningEffort">;
};

/** Already-normalized spawn policy; model authorization and activity remain shared. */
export function createSpawnExecution(
  deps: AgentToolExecuteDeps,
  start: (
    ctx: SubagentContext,
    type: SubagentType,
    prompt: string,
    options: SpawnOptions,
    signal?: AbortSignal,
  ) => string | Promise<string>,
) {
  const { pi, manager, agentActivity, fleet, isScopeModelsEnabled } = deps;
  return async (
    toolCallId: string,
    params: {
      message: string;
      agent: ResolvedAgent;
      forkContext: boolean;
      taskName?: string;
      model?: string;
      reasoning_effort?: string;
    },
    signal: AbortSignal | undefined,
    _onUpdate: AgentToolUpdate | undefined,
    ctx: SubagentContext,
  ): Promise<{ agentId: string; details: AgentDetails }> => {
    signal?.throwIfAborted();
    ctx.signal?.throwIfAborted();
    if (!params.message.trim()) return failedResult("Empty message can't be sent to an agent.");
    const { type: subagentType, config: agentConfig } = params.agent;
    const description = params.taskName ?? deriveDisplayDescription(params.message);
    const displayName = description || getDisplayName(subagentType);
    let resolvedConfig;
    try {
      resolvedConfig = resolveAgentInvocationConfig(
        agentConfig,
        params,
        {
          ...ctx,
          thinking: ctx.thinking ?? pi.getThinkingLevel(),
          scopeModels: ctx.scopeModels ?? isScopeModelsEnabled(),
        },
        deps.getModelDefaults?.(),
      );
    } catch (error) {
      return failedResult(error instanceof Error ? error.message : String(error), subagentType);
    }
    const { model, thinking } = resolvedConfig;

    const agentInvocation: AgentInvocation = {
      modelName: model ? `${model.provider}/${model.id}` : undefined,
      thinking,
    };
    const { tags } = buildInvocationTags(agentInvocation);
    const { state, callbacks } = createActivityTracker();

    signal?.throwIfAborted();
    ctx.signal?.throwIfAborted();
    const options = {
      taskName: params.taskName,
      description: displayName,
      model,
      thinkingLevel: thinking,
      forkContext: params.forkContext,
      invocation: agentInvocation,
      allowedTools: ctx.allowedTools,
      ...callbacks,
    };
    const id = await start(ctx, subagentType, params.message, options, signal);

    const record = manager.getRecord(id);
    if (record) record.toolCallId = toolCallId;
    agentActivity.set(id, state);
    fleet.ensureTimer();
    fleet.update();

    const status = record?.status === "queued" ? "queued" : "running";
    return {
      agentId: id,
      details: {
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
    };
  };
}

function failedResult(message: string, subagentType = "default"): never {
  throw new SubagentOperationError(message, {
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
