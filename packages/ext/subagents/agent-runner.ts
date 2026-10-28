import { join } from "node:path";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  type FileEntry,
  type AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  createCodemodeExtension,
  createToolSearchExtension,
  DefaultResourceLoader,
  type ExtensionAPI,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import * as agentSession from "./agent-session-shutdown.js";
import { resolveAgent } from "./agent-types.js";
import type { RegisterCollaboration } from "./subagent-context.js";
import { extractText } from "./message-text.js";
import { detectEnv } from "./env.js";
import { snapshotParent, type ParentSnapshot } from "./parent-snapshot.js";
import { buildAgentPrompt } from "./prompts.js";
import { SUBAGENT_METADATA_ENTRY, type SubagentMetadata } from "./metadata.js";
import { runAsSubagent } from "./subagent-context.js";
import { createSubagentEventBus } from "./subagent-event-bus.js";
import {
  isThinkingLevel,
  type AgentFailure,
  type SubagentType,
  type ThinkingLevel,
} from "./types.js";
import type { AssistantUsage } from "./usage.js";

/**
 * Try to find the right model for an agent type.
 * Priority: explicit option > config.model > parent model.
 */
function resolveDefaultModel(
  parentModel: Model<Api> | undefined,
  availableModels: Model<Api>[],
  configModel?: string,
): Model<Api> | undefined {
  if (configModel) {
    const slashIdx = configModel.indexOf("/");
    if (slashIdx !== -1) {
      const provider = configModel.slice(0, slashIdx);
      const modelId = configModel.slice(slashIdx + 1);
      const found = availableModels.find(
        (candidate) => candidate.provider === provider && candidate.id === modelId,
      );
      if (found) return found;
    }
  }
  return parentModel;
}

/** Info about a tool event in the subagent. */
export interface ToolActivity {
  type: "start" | "end" | "call";
  toolName: string;
  arguments?: Record<string, unknown>;
}

function dispatchToolActivity(
  event: AgentSessionEvent,
  onToolActivity: ((activity: ToolActivity) => void) | undefined,
): void {
  if (event.type === "tool_execution_start") {
    onToolActivity?.({ type: "start", toolName: event.toolName });
  } else if (event.type === "tool_execution_end") {
    onToolActivity?.({ type: "end", toolName: event.toolName });
  } else if (event.type === "message_end" && event.message.role === "assistant") {
    for (const part of event.message.content) {
      if (part.type === "toolCall") {
        onToolActivity?.({
          type: "call",
          toolName: part.name,
          arguments: part.arguments,
        });
      }
    }
  }
}

export interface RunOptions {
  registerCollaboration?: RegisterCollaboration;
  /** ExtensionAPI instance — used for pi.exec() instead of execSync. */
  pi: ExtensionAPI;
  /** Manager-assigned id; suffixes session name to disambiguate parallel spawns (e.g. `explorer#a1b2c3d4`). */
  agentId?: string;
  /** Identity of this live conversation, distinct from the retained agent id. */
  agentSessionId?: string;
  model?: Model<Api>;
  signal?: AbortSignal;
  isolated?: boolean;
  thinkingLevel?: ThinkingLevel;
  /** Sanitized manager-owned conversation, never extension state. */
  conversation?: { sessionId: string; cwd: string; entries: FileEntry[] };
  allowedTools?: string[];
  /** Selected parent conversation entries imported into an independent child. */
  parentEntries?: ReturnType<ExtensionContext["sessionManager"]["buildContextEntries"]>;
  /** Override working directory. */
  cwd?: string;
  /**
   * Where .pi config is discovered (project extensions, skills, pi settings).
   * Default: same as the working directory. The manager sets
   * this to the parent session's cwd when `SpawnOptions.cwd` points the
   * working directory elsewhere — the agent works *there* but carries the
   * parent project's config (the target's `.pi` extensions never execute).
   *
   * WARNING for future callers: if you pass `cwd` pointing at a directory the
   * user didn't open, you almost certainly must pass `configCwd` too —
   * omitting it makes the target's `.pi` extensions execute in this process.
   */
  configCwd?: string;
  /** Called on tool start/end with activity info. */
  onToolActivity?: (activity: ToolActivity) => void;
  /** Called on streaming text deltas from the assistant response. */
  onTextDelta?: (delta: string, fullText: string) => void;
  onSessionCreated?: (session: AgentSession) => void;
  /** Called at the end of each agentic turn with the cumulative count. */
  onTurnEnd?: (turnCount: number) => void;
  /**
   * Called once per assistant message_end with that message's usage delta.
   * Lets callers maintain a lifetime accumulator that survives compaction
   * (which replaces session.state.messages and resets stats-derived sums).
   */
  onAssistantUsage?: (usage: AssistantUsage) => void;
  /**
   * Called when the session successfully compacts. `tokensBefore` is upstream's
   * pre-compaction context size estimate. Aborted compactions don't fire.
   */
  onCompaction?: (info: {
    reason: "manual" | "threshold" | "overflow";
    tokensBefore: number;
  }) => void;
  /** Called for every failed assistant response, not only the terminal one. */
  onAssistantFailure?: (failure: AgentFailure) => void;
}

export interface RunResult {
  responseText: string;
  session: AgentSession;
}

function getAssistantUsage(message: AssistantMessage): AssistantUsage {
  const { usage } = message;
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    cost: usage.cost.total,
    provider: message.provider,
    model: message.model,
    timestamp: message.timestamp,
  };
}

/**
 * Collect this invocation's terminal assistant response, even if compaction rewrites history.
 */
function collectResponseText(session: AgentSession) {
  let text: string | undefined;
  let terminal: AssistantMessage | undefined;
  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    // Queue-only mail can start after the final assistant response, before prompt resolves.
    if (event.type === "message_start" && event.message.role === "assistant") {
      text = "";
      terminal = undefined;
    }
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      text = (text ?? "") + event.assistantMessageEvent.delta;
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      terminal = event.message;
      text = extractText(event.message.content).trim();
    }
  });
  return {
    getText() {
      // Pi resolves prompt() after provider errors; preserve their actual cause.
      if (terminal?.stopReason === "error") {
        throw new Error(
          terminal.errorMessage?.trim() || "Agent failed without provider error details.",
        );
      }
      return text ?? "";
    },
    unsubscribe,
  };
}

/**
 * Wire an AbortSignal to abort a session.
 * Returns a cleanup function to remove the listener.
 */
function forwardAbortSignal(session: AgentSession, signal?: AbortSignal): () => void {
  if (!signal) return () => {};
  if (signal.aborted) {
    void session.abort();
    return () => {};
  }
  const listener = () => {
    void session.abort();
  };
  signal.addEventListener("abort", listener, { once: true });
  return () => signal.removeEventListener("abort", listener);
}

function reportAssistantFailure(
  event: AgentSessionEvent,
  options: Pick<RunOptions, "onAssistantFailure" | "signal">,
): void {
  if (event.type !== "message_end" || event.message.role !== "assistant") return;
  const message = event.message;
  if (message.stopReason !== "error" && message.stopReason !== "aborted") return;
  try {
    options.onAssistantFailure?.({
      timestamp: message.timestamp,
      phase: "assistant",
      message:
        message.errorMessage?.trim() || `Assistant response ended with ${message.stopReason}`,
      stop_reason: message.stopReason,
      provider: message.provider,
      model: message.model,
      manager_signal_aborted: options.signal?.aborted ?? false,
    });
  } catch {
    // Failure reporting must not replace the original failure.
  }
}

export async function openAgentSession(
  parentSource: ParentSnapshot | ExtensionContext,
  type: SubagentType,
  options: RunOptions,
): Promise<AgentSession> {
  agentSession.assertAgentNotCancelled(options.signal);
  const parent = "systemPrompt" in parentSource ? parentSource : snapshotParent(parentSource);
  const agentConfig = resolveAgent(type).config;

  // Resolve working directory: caller override > parent cwd
  const effectiveCwd = options.cwd ?? parent.cwd;
  // Filesystem work happens in effectiveCwd; config discovery in configCwd.
  // They differ only for SpawnOptions.cwd spawns (config stays with the parent).
  const configCwd = options.configCwd ?? effectiveCwd;

  const env = await detectEnv(options.pi, effectiveCwd, options.signal);
  agentSession.assertAgentNotCancelled(options.signal);

  const noExtensions = options.isolated === true;
  const toolNames = [...agentConfig.builtinToolNames];
  const systemPrompt = buildAgentPrompt(agentConfig, effectiveCwd, env, parent.systemPrompt);

  const agentDir = getAgentDir();

  // Embedded roles explicitly load native builtins and this extension. The closure
  // reapplies child identity on reload; no project/discovered extensions execute.
  // Isolated RPC spawns load no extensions.
  const loader = new DefaultResourceLoader({
    cwd: configCwd,
    agentDir,
    noExtensions: true,
    extensionFactories: noExtensions
      ? []
      : [
          {
            name: "codemode",
            factory: createCodemodeExtension({ mode: "on", models: false }),
            // The adapter replaces this default with its scoped native registration.
            replaceable: true,
          },
          createToolSearchExtension(),
          (pi) =>
            runAsSubagent(
              { type, registerCollaboration: options.registerCollaboration },
              async () => (await import("../index.js")).default(pi),
            ),
        ],
    eventBus: createSubagentEventBus(options.pi.events),
    noSkills: options.isolated === true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => systemPrompt,
    appendSystemPromptOverride: () => [],
  });

  await loader.reload();
  agentSession.assertAgentNotCancelled(options.signal);

  // Resolve model: explicit option > config.model > parent model
  const model =
    options.model ?? resolveDefaultModel(parent.model, parent.availableModels, agentConfig.model);

  // Resolve thinking level: explicit option > agent config > undefined (inherit)
  const configuredThinking = options.thinkingLevel ?? agentConfig.thinking;
  const thinkingLevel = isThinkingLevel(configuredThinking) ? configuredThinking : undefined;

  const extensionToolNames = noExtensions
    ? []
    : loader.getExtensions().extensions.flatMap((extension) => [...extension.tools.keys()]);
  const allowedTools = [...new Set([...toolNames, ...extensionToolNames])];

  const settingsManager = SettingsManager.create(configCwd, agentDir);
  const sessionManager = options.conversation
    ? SessionManager.inMemory(
        effectiveCwd,
        { id: options.conversation.sessionId },
        options.conversation.entries,
      )
    : options.parentEntries
      ? SessionManager.inMemory(
          effectiveCwd,
          { parentSession: parent.sessionId },
          options.parentEntries,
        )
      : SessionManager.inMemory(effectiveCwd);

  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
    signal: options.signal,
  });
  agentSession.assertAgentNotCancelled(options.signal);
  for (const [providerId, provider] of parent.providers) {
    modelRuntime.registerProvider(providerId, provider);
  }

  const sessionOpts: NonNullable<Parameters<typeof createAgentSession>[0]> = {
    cwd: effectiveCwd,
    agentDir,
    sessionManager,
    settingsManager,
    modelRuntime,
    model,
    scopedModels: parent.scopedModels,
    // SDK tools is a persistent registry ceiling, not only the initial active list.
    // Keep underlying cores and permitted owned tools, even when projection hides them.
    tools: options.allowedTools
      ? allowedTools.filter((name) => options.allowedTools?.includes(name))
      : allowedTools,
    resourceLoader: loader,
  };
  if (thinkingLevel) {
    sessionOpts.thinkingLevel = thinkingLevel;
  }

  const { session } = await createAgentSession(sessionOpts);
  try {
    if (options.signal?.aborted) await agentSession.shutdownCancelledAgentSession(session);

    sessionManager.appendCustomEntry(SUBAGENT_METADATA_ENTRY, {
      agentId: options.agentId,
      agentSessionId: options.agentSessionId,
      type,
      title: agentConfig.displayName ?? agentConfig.name,
      bashGatePolicy: agentConfig.bashGatePolicy,
    } satisfies SubagentMetadata);

    const baseSessionName = agentConfig.name;
    session.setSessionName(
      options.agentId ? `${baseSessionName}#${options.agentId.slice(0, 8)}` : baseSessionName,
    );

    await agentSession.bindAgentSessionExtensions(
      session,
      {
        onError: (err) => {
          options.onToolActivity?.({
            type: "end",
            toolName: `extension-error:${err.extensionPath}`,
          });
        },
      },
      options.signal,
    );
    if (options.signal?.aborted) await agentSession.shutdownCancelledAgentSession(session);
    options.onSessionCreated?.(session);

    return session;
  } catch (error) {
    await agentSession.shutdownAgentSession(session);
    throw error;
  }
}

export async function runAgent(
  parentSource: ParentSnapshot | ExtensionContext,
  type: SubagentType,
  prompt: string,
  options: RunOptions,
): Promise<RunResult> {
  const session = await openAgentSession(parentSource, type, options);

  let turnCount = 0;

  let currentMessageText = "";
  const unsubTurns = session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "turn_end") {
      turnCount++;
      options.onTurnEnd?.(turnCount);
    }
    if (event.type === "message_start") {
      currentMessageText = "";
    }
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      currentMessageText += event.assistantMessageEvent.delta;
      options.onTextDelta?.(event.assistantMessageEvent.delta, currentMessageText);
    }
    dispatchToolActivity(event, options.onToolActivity);
    if (event.type === "message_end" && event.message.role === "assistant") {
      options.onAssistantUsage?.(getAssistantUsage(event.message));
    }
    if (event.type === "entry_appended" && event.entry.type === "compaction") {
      options.onCompaction?.({ reason: "threshold", tokensBefore: event.entry.tokensBefore });
    }
    if (event.type === "compaction_end" && !event.aborted && event.result) {
      options.onCompaction?.({ reason: event.reason, tokensBefore: event.result.tokensBefore });
    }
    reportAssistantFailure(event, options);
  });

  const collector = collectResponseText(session);
  const cleanupAbort = forwardAbortSignal(session, options.signal);

  try {
    if (options.signal?.aborted) await agentSession.shutdownCancelledAgentSession(session);
    await session.prompt(prompt);
  } finally {
    unsubTurns();
    collector.unsubscribe();
    cleanupAbort();
  }

  const responseText = collector.getText();
  return { responseText, session };
}

/**
 * Send a new prompt to an existing session (resume).
 */
export async function resumeAgent(
  session: AgentSession,
  prompt: string,
  options: {
    onToolActivity?: (activity: ToolActivity) => void;
    onTurnEnd?: (turnCount: number) => void;
    onTextDelta?: (delta: string, fullText: string) => void;
    onAssistantUsage?: (usage: AssistantUsage) => void;
    onCompaction?: (info: {
      reason: "manual" | "threshold" | "overflow";
      tokensBefore: number;
    }) => void;
    onAssistantFailure?: (failure: AgentFailure) => void;
    signal?: AbortSignal;
    /** Scheduling instruction, not another user/task boundary in inherited history. */
    taskContinuation?: boolean;
  } = {},
): Promise<string> {
  agentSession.assertAgentNotCancelled(options.signal);
  const collector = collectResponseText(session);
  const cleanupAbort = forwardAbortSignal(session, options.signal);

  let turnCount = 0;
  let currentMessageText = "";
  const unsubEvents =
    options.onToolActivity ||
    options.onTurnEnd ||
    options.onTextDelta ||
    options.onAssistantUsage ||
    options.onCompaction ||
    options.onAssistantFailure
      ? session.subscribe((event: AgentSessionEvent) => {
          if (event.type === "turn_end") options.onTurnEnd?.(++turnCount);
          if (event.type === "message_start") currentMessageText = "";
          if (
            event.type === "message_update" &&
            event.assistantMessageEvent.type === "text_delta"
          ) {
            currentMessageText += event.assistantMessageEvent.delta;
            options.onTextDelta?.(event.assistantMessageEvent.delta, currentMessageText);
          }
          dispatchToolActivity(event, options.onToolActivity);
          if (event.type === "message_end" && event.message.role === "assistant") {
            options.onAssistantUsage?.(getAssistantUsage(event.message));
          }
          if (event.type === "entry_appended" && event.entry.type === "compaction") {
            options.onCompaction?.({ reason: "threshold", tokensBefore: event.entry.tokensBefore });
          }
          if (event.type === "compaction_end" && !event.aborted && event.result) {
            options.onCompaction?.({
              reason: event.reason,
              tokensBefore: event.result.tokensBefore,
            });
          }
          reportAssistantFailure(event, options);
        })
      : () => {};

  try {
    if (options.taskContinuation) {
      await session.sendCustomMessage(
        {
          customType: "subagent-task-continuation",
          content: prompt,
          display: false,
        },
        { triggerTurn: true },
      );
    } else {
      await session.prompt(prompt);
    }
  } finally {
    collector.unsubscribe();
    unsubEvents();
    cleanupAbort();
  }

  return collector.getText();
}

/**
 * Send a steering message to a running subagent.
 * The message is consumed after the current assistant response's tool-call batch.
 */
export async function steerAgent(session: AgentSession, message: string): Promise<void> {
  await session.steer(message);
}
