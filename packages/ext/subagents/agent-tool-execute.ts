import type { Api, Model } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createActivityTracker } from "./activity-tracker.js";
import { type AgentManager } from "./agent-manager.js";
import { getAgentConfig, resolveType } from "./agent-types.js";
import { isModelInScope, readEnabledModels, resolveEnabledModels } from "./enabled-models.js";
import { resolveAgentInvocationConfig, resolveJoinMode } from "./invocation-config.js";
import { resolveModel } from "./model-resolver.js";
import { createOutputFilePath, streamToOutputFile, writeInitialEntry } from "./output-file.js";
import { getStatusNote } from "./status-note.js";
import { buildDetails, formatLifetimeTokens, textResult } from "./tool-result.js";
import {
  type AgentInvocation,
  type AgentRecord,
  type IsolationMode,
  type JoinMode,
  type SubagentType,
  type ThinkingLevel,
} from "./types.js";
import {
  type AgentActivity,
  type AgentDetails,
  buildInvocationTags,
  describeActivity,
  formatBashApprovalActivity,
  formatMs,
  getDisplayName,
  SPINNER,
} from "./ui/agent-format.js";
import { type FleetList } from "./ui/fleet-list.js";

type AgentToolParams = {
  subagent_type: string;
  description: string;
  prompt: string;
  model?: string;
  thinking?: string;
  run_in_background?: boolean;
  isolated?: boolean;
  isolation?: IsolationMode;
};

type AgentToolUpdate = (update: {
  content: Array<{ type: "text"; text: string }>;
  details: AgentDetails;
}) => void;

type ExecuteRequest = {
  toolCallId: string;
  params: AgentToolParams;
  signal?: AbortSignal;
  onUpdate?: AgentToolUpdate;
  ctx: ExtensionContext;
};

type DetailBase = Pick<
  AgentDetails,
  "displayName" | "description" | "subagentType" | "modelName" | "tags"
>;

type PreparedInvocation = {
  rawType: SubagentType;
  subagentType: SubagentType;
  fellBack: boolean;
  displayName: string;
  model: Model<Api> | undefined;
  isolated: boolean;
  inheritContext: boolean;
  thinking?: ThinkingLevel;
  isolation?: IsolationMode;
  runInBackground: boolean;
  agentInvocation: AgentInvocation;
  detailBase: DetailBase;
};

type AgentToolExecuteDeps = {
  pi: ExtensionAPI;
  manager: AgentManager;
  agentActivity: Map<string, AgentActivity>;
  fleet: FleetList;
  reloadCustomAgents: () => void;
  isScopeModelsEnabled: () => boolean;
  getDefaultJoinMode: () => JoinMode;
  trackSpawned: (id: string, joinMode: JoinMode) => void;
  updateHelperToolsActive?: () => void;
  setRenderMetadata?: (toolCallId: string, model: string, thinking: ThinkingLevel) => void;
};

async function runBackgroundAgent(
  deps: AgentToolExecuteDeps,
  request: ExecuteRequest,
  invocation: PreparedInvocation,
) {
  const { pi, manager, agentActivity, fleet } = deps;
  const { getDefaultJoinMode, trackSpawned, updateHelperToolsActive } = deps;
  const { toolCallId, params, ctx } = request;
  const {
    subagentType,
    displayName,
    model,
    isolated,
    inheritContext,
    thinking,
    isolation,
    agentInvocation,
    detailBase,
  } = invocation;
  const { state: bgState, callbacks: bgCallbacks } = createActivityTracker();

  // Wrap onSessionCreated to wire output file streaming.
  // The callback lazily reads record.outputFile (set right after spawn)
  // rather than closing over a value that doesn't exist yet.
  let id: string;
  const origBgOnSession = bgCallbacks.onSessionCreated;
  bgCallbacks.onSessionCreated = (session: AgentSession) => {
    origBgOnSession(session);
    const rec = manager.getRecord(id);
    if (rec?.outputFile) {
      rec.outputCleanup = streamToOutputFile(session, rec.outputFile, id, ctx.cwd);
    }
  };

  try {
    id = manager.spawn(pi, ctx, subagentType, params.prompt, {
      description: params.description,
      model,
      isolated,
      inheritContext,
      thinkingLevel: thinking,
      isBackground: true,
      isolation,
      invocation: agentInvocation,
      ...bgCallbacks,
    });
  } catch (err) {
    return textResult(err instanceof Error ? err.message : String(err));
  }

  // Set output file + join mode synchronously after spawn, before the
  // event loop yields — onSessionCreated is async so this is safe.
  const joinMode = resolveJoinMode(getDefaultJoinMode(), true);
  const record = manager.getRecord(id);
  if (record && joinMode) {
    record.joinMode = joinMode;
    record.toolCallId = toolCallId;
    record.outputFile = createOutputFilePath(ctx.cwd, id, ctx.sessionManager.getSessionId());
    writeInitialEntry(record.outputFile, id, params.prompt, ctx.cwd);
  }

  if (joinMode != null) trackSpawned(id, joinMode);

  agentActivity.set(id, bgState);
  fleet.ensureTimer();
  fleet.update();

  // Emit created event
  pi.events.emit("subagents:created", {
    id,
    type: subagentType,
    description: params.description,
    isBackground: true,
  });
  updateHelperToolsActive?.();

  const isQueued = record?.status === "queued";
  return textResult(
    `Agent ${isQueued ? "queued" : "started"} in background.\n` +
      `Agent ID: ${id}\n` +
      `Type: ${displayName}\n` +
      `Description: ${params.description}\n` +
      (record?.outputFile ? `Output file: ${record.outputFile}\n` : "") +
      (isQueued ? `Position: queued (max ${manager.getMaxConcurrent()} concurrent)\n` : "") +
      `\nYou will be notified automatically when this agent completes.\n` +
      `Use MessageAgent to send it a message while it is running.\n` +
      `Do not poll or duplicate this agent's work.`,
    {
      ...detailBase,
      toolUses: 0,
      tokens: "",
      durationMs: 0,
      status: isQueued ? ("queued" as const) : ("background" as const),
      agentId: id,
    },
  );
}

async function runForegroundAgent(
  deps: AgentToolExecuteDeps,
  request: ExecuteRequest,
  invocation: PreparedInvocation,
) {
  const { pi, manager, agentActivity, fleet } = deps;
  const { params, signal, onUpdate, ctx } = request;
  const {
    subagentType,
    rawType,
    fellBack,
    model,
    isolated,
    inheritContext,
    thinking,
    isolation,
    agentInvocation,
    detailBase,
  } = invocation;
  // Foreground (synchronous) execution — stream progress via onUpdate
  let spinnerFrame = 0;
  const startedAt = Date.now();
  let fgId: string | undefined;

  const streamUpdate = () => {
    const details: AgentDetails = {
      ...detailBase,
      toolUses: fgState.toolUses,
      tokens: formatLifetimeTokens(fgState),
      turnCount: fgState.turnCount,
      durationMs: Date.now() - startedAt,
      status: "running",
      activity: fgState.bashApproval
        ? formatBashApprovalActivity(fgState.bashApproval.command)
        : describeActivity(fgState.activeTools, fgState.responseText),
      bashApprovalCommand: fgState.bashApproval?.command,
      spinnerFrame: spinnerFrame % SPINNER.length,
      toolCalls: fgState.toolCalls,
      lifetimeUsage: fgState.lifetimeUsage,
    };
    onUpdate?.({
      content: [{ type: "text", text: `${fgState.toolUses} tool uses...` }],
      details,
    });
  };

  const { state: fgState, callbacks: fgCallbacks } = createActivityTracker(streamUpdate);

  // Wire session creation: register in FleetView + stream to output file.
  // The output file path is set synchronously after spawn (below),
  // before onSessionCreated fires — same pattern as background agents.
  const origOnSession = fgCallbacks.onSessionCreated;
  fgCallbacks.onSessionCreated = (session: AgentSession) => {
    origOnSession(session);
    for (const a of manager.listAgents()) {
      if (a.session === session) {
        fgId = a.id;
        agentActivity.set(a.id, fgState);
        break;
      }
    }
    // Stream conversation to output file (foreground agent logging)
    if (fgId) {
      const rec = manager.getRecord(fgId);
      if (rec?.outputFile) {
        rec.outputCleanup = streamToOutputFile(session, rec.outputFile, fgId, ctx.cwd);
      }
    }
  };

  // Animate spinner at ~80ms (smooth rotation through 10 braille frames)
  const spinnerInterval = setInterval(() => {
    spinnerFrame++;
    streamUpdate();
  }, 80);

  streamUpdate();

  let record: AgentRecord;
  try {
    const fgResult = await manager.spawnAndWait(
      pi,
      ctx,
      subagentType,
      params.prompt,
      {
        description: params.description,
        model,
        isolated,
        inheritContext,
        thinkingLevel: thinking,
        isolation,
        invocation: agentInvocation,
        signal,
        ...fgCallbacks,
      },
      (fgAgentId: string) => {
        // onSpawned: called synchronously after spawn, before onSessionCreated fires.
        // Set up the output file so streamToOutputFile can pick it up.
        const fgRec = manager.getRecord(fgAgentId);
        if (fgRec) {
          fgRec.outputFile = createOutputFilePath(
            ctx.cwd,
            fgAgentId,
            ctx.sessionManager.getSessionId(),
          );
          writeInitialEntry(fgRec.outputFile, fgAgentId, params.prompt, ctx.cwd);
        }
      },
    );
    record = fgResult.record;
  } catch (err) {
    clearInterval(spinnerInterval);
    return textResult(err instanceof Error ? err.message : String(err));
  }

  clearInterval(spinnerInterval);

  // Clean up foreground agent from FleetView
  if (fgId) {
    agentActivity.delete(fgId);
    fleet.onAgentFinished(fgId);
  }

  // Get final token count
  const tokenText = formatLifetimeTokens(fgState);

  const details = buildDetails(detailBase, record, fgState, {
    tokens: tokenText,
  });

  // "general" may itself be unregistered (defaults disabled, no
  // user override) — getConfig then uses the hardcoded fallback config.
  const fallbackNote = fellBack
    ? `Note: Unknown agent type "${rawType}" — using ${resolveType("general") ? "general" : "the fallback agent config"}.\n\n`
    : "";

  if (record.status === "error") {
    return textResult(`${fallbackNote}Agent failed: ${record.error}`, details);
  }

  const durationMs = (record.completedAt ?? Date.now()) - record.startedAt;
  const statsParts = [`${record.toolUses} tool uses`];
  if (tokenText) statsParts.push(tokenText);
  return textResult(
    `${fallbackNote}Agent completed in ${formatMs(durationMs)} (${statsParts.join(", ")})${getStatusNote(record.status)}.\n\n` +
      (record.result?.trim() || "No output."),
    details,
  );
}

export function createAgentToolExecute(deps: AgentToolExecuteDeps) {
  const { reloadCustomAgents, isScopeModelsEnabled } = deps;
  return async (
    toolCallId: string,
    params: AgentToolParams,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdate | undefined,
    ctx: ExtensionContext,
  ) => {
    // Reload custom agents so new .pi/agents/*.md files are picked up without restart
    reloadCustomAgents();

    const rawType = params.subagent_type as SubagentType;
    const resolved = resolveType(rawType);
    const subagentType = resolved ?? "general";
    const fellBack = resolved === undefined;

    const displayName = getDisplayName(subagentType);

    // Get agent config (if any)
    const customConfig = getAgentConfig(subagentType);

    const resolvedConfig = resolveAgentInvocationConfig(customConfig, params);

    // Resolve model from agent config first; tool-call params only fill gaps.
    let model = ctx.model as Model<Api> | undefined;
    if (resolvedConfig.modelInput) {
      const resolved = resolveModel(resolvedConfig.modelInput, ctx.modelRegistry);
      if (typeof resolved === "string") {
        if (resolvedConfig.modelFromParams) return textResult(resolved);
        // config-specified: silent fallback to parent
      } else {
        model = resolved;
      }
    }

    // Scope validation: the effective resolved model is checked against the
    // user's enabledModels list (read in `enabled-models.ts`).
    //
    // Design: scopeModels guards against *runtime* LLM choices, not user-level config.
    //   - Caller-supplied out-of-scope → hard error (the orchestrator made an explicit
    //     out-of-scope choice; surface it so it picks differently).
    //   - Frontmatter-pinned or parent-inherited out-of-scope → warn but proceed (the
    //     user authored/installed this agent or chose the parent's model; trust it).
    // See SubagentsSettings.scopeModels docstring for the full policy.
    if (isScopeModelsEnabled() && model) {
      const allowed = resolveEnabledModels(readEnabledModels(ctx.cwd), ctx.modelRegistry, ctx.cwd);
      if (allowed && !isModelInScope(model, allowed)) {
        if (resolvedConfig.modelFromParams) {
          const list = [...allowed]
            .sort()
            .map((m) => `  ${m}`)
            .join("\n");
          return textResult(
            `Model not in scope: "${resolvedConfig.modelInput}".\n\n` +
              `Allowed models (from enabledModels):\n${list}`,
          );
        }
        // Frontmatter-pinned or parent-inherited: warn + proceed.
        const agentLabel = customConfig?.displayName ?? subagentType;
        const modelLabel = resolvedConfig.modelInput ?? `${model.provider}/${model.id}`;
        ctx.ui.notify(`Agent "${agentLabel}" using out-of-scope model "${modelLabel}"`, "warning");
      }
    }

    const thinking: ThinkingLevel =
      model?.reasoning === false ? "off" : (resolvedConfig.thinking ?? deps.pi.getThinkingLevel());
    if (model) deps.setRenderMetadata?.(toolCallId, `${model.provider}/${model.id}`, thinking);
    const inheritContext = resolvedConfig.inheritContext;
    const runInBackground = resolvedConfig.runInBackground;
    const isolated = resolvedConfig.isolated;
    const isolation = resolvedConfig.isolation;

    const modelName = model ? `${model.provider}/${model.id}` : undefined;
    const agentInvocation: AgentInvocation = {
      modelName,
      thinking,
      isolated,
      inheritContext,
      runInBackground,
      isolation,
    };
    const { tags: agentTags } = buildInvocationTags(agentInvocation);
    const detailBase = {
      displayName,
      description: params.description,
      subagentType,
      modelName,
      tags: agentTags.length > 0 ? agentTags : undefined,
    };

    const request: ExecuteRequest = {
      toolCallId,
      params,
      signal,
      onUpdate,
      ctx,
    };
    const invocation: PreparedInvocation = {
      rawType,
      subagentType,
      fellBack,
      displayName,
      model,
      isolated,
      inheritContext,
      thinking,
      isolation,
      runInBackground,
      agentInvocation,
      detailBase,
    };

    return runInBackground
      ? runBackgroundAgent(deps, request, invocation)
      : runForegroundAgent(deps, request, invocation);
  };
}
