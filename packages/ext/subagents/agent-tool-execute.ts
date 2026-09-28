import type { SubagentContext } from "./operation-context.js";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createActivityTracker } from "./activity-tracker.js";
import type { AgentManager } from "./agent-manager.js";
import { resolveSpawnAgent, type ResolvedAgent } from "./agent-types.js";
import { resolveAgentInvocationConfig } from "./invocation-config.js";
import { modelKey, resolveModel } from "./model-resolver.js";
import { v1Result, SubagentOperationError } from "./tool-result.js";
import {
  isThinkingLevel,
  type AgentInvocation,
  type ThinkingLevel,
  type SpawnOptions,
  type SubagentType,
} from "./types.js";
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
};

export function createAgentToolExecute(deps: AgentToolExecuteDeps) {
  const parentAgentType = getActiveSubagent();
  const execute = createSpawnExecution(deps, (ctx, type, prompt, options) =>
    deps.manager.spawn(deps.pi, ctx, type, prompt, options),
  );
  return async (
    callId: string,
    params: AgentToolParams,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdate | undefined,
    ctx: SubagentContext,
  ) => {
    if (!params.message.trim()) return failedResult("Empty message can't be sent to an agent.");
    const role = resolveSpawnAgent(
      params.agent_type,
      params.fork_context,
      ctx.parentRole ?? parentAgentType,
    );
    if ("error" in role) return failedResult(role.error);
    const result = await execute(
      callId,
      {
        message: params.message,
        model: params.model,
        reasoning_effort: params.reasoning_effort,
        agent: role.agent,
        forkContext: params.fork_context === true,
      },
      signal,
      onUpdate,
      ctx,
    );
    return v1Result(
      { agent_id: result.agentId, nickname: result.details.displayName || null },
      result.details,
    );
  };
}

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

    if ((ctx.scopeModels ?? isScopeModelsEnabled()) && model) {
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
      model?.reasoning === false
        ? "off"
        : (resolvedConfig.thinking ?? ctx.thinking ?? pi.getThinkingLevel());

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
