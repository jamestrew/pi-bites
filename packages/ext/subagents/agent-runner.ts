import { join, resolve } from "node:path";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext, LoadExtensionsResult } from "@earendil-works/pi-coding-agent";
import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { installTurnBoundaryAutoCompaction } from "../auto-compaction.js";
import * as agentSession from "./agent-session-shutdown.js";
import { resolveAgent } from "./agent-types.js";
import { createMessageAgent } from "./message-agent.js";
import { extractText } from "./message-text.js";
import { detectEnv } from "./env.js";
import { snapshotParent, type ParentSnapshot } from "./parent-snapshot.js";
import { buildAgentPrompt } from "./prompts.js";
import {
  abortReason,
  emitDiagnostic,
  errorInfo,
  observeAbortSignal,
  recordSessionDiagnostic,
  summarizeProviderPayload,
  summarizeProviderResponse,
} from "./runner-diagnostics.js";
import { Type, type Static } from "typebox";
import * as Value from "typebox/value";
import { runAsSubagent } from "./subagent-context.js";
import { createSubagentEventBus } from "./subagent-event-bus.js";
import {
  isThinkingLevel,
  type AgentFailure,
  type SubagentType,
  type ThinkingLevel,
} from "./types.js";
import type { AssistantUsage } from "./usage.js";

/** Tool names shared by this extension's registration and subagent exclusion. */
export const SUBAGENT_TOOL_NAMES = {
  AGENT: "Agent",
  WAIT_AGENT: "WaitAgent",
  MESSAGE_AGENT: "MessageAgent",
} as const;

/** Names of tools registered by this extension that subagents must NOT inherit. */
const EXCLUDED_TOOL_NAMES: string[] = Object.values(SUBAGENT_TOOL_NAMES);

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

export const SUBAGENT_METADATA_ENTRY = "pi-bites:subagent";

export const SubagentMetadataSchema = Type.Object({
  agentId: Type.Optional(Type.String()),
  type: Type.String(),
  title: Type.String(),
  bashGatePolicy: Type.Optional(Type.Union([Type.Literal("deny"), Type.Literal("prompt")])),
});

export type SubagentMetadata = Static<typeof SubagentMetadataSchema>;

export function parseSubagentMetadata(value: unknown): SubagentMetadata | undefined {
  return Value.Check(SubagentMetadataSchema, value) ? value : undefined;
}

export interface RunOptions {
  /** ExtensionAPI instance — used for pi.exec() instead of execSync. */
  pi: ExtensionAPI;
  /** Manager-assigned id; suffixes session name to disambiguate parallel spawns (e.g. `Explore#a1b2c3d4`). */
  agentId?: string;
  model?: Model<Api>;
  signal?: AbortSignal;
  isolated?: boolean;
  thinkingLevel?: ThinkingLevel;
  /** Pi-bites threshold policy captured by the owning parent extension. */
  autoCompactionThreshold?: number;
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
  /** Fixed transport to the session that spawned this child. */
  messageParent: (message: string) => boolean;
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
  /** Receives safe lifecycle/provider observations for persistent diagnostics. */
  onDiagnostic?: (event: string, details?: Record<string, unknown>) => void;
  /** Called for every failed assistant response, not only the terminal one. */
  onAssistantFailure?: (failure: AgentFailure) => void;
}

export interface RunResult {
  responseText: string;
  session: AgentSession;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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

function getToolCallName(value: unknown): string {
  if (!isRecord(value)) return "unknown";
  if (typeof value.name === "string") return value.name;
  return typeof value.toolName === "string" ? value.toolName : "unknown";
}

/**
 * Subscribe to a session and collect the last assistant message text.
 * Returns an object with a `getText()` getter and an `unsubscribe` function.
 */
function collectResponseText(session: AgentSession) {
  let text: string | undefined;
  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "message_start") text = "";
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      text = (text ?? "") + event.assistantMessageEvent.delta;
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      text = extractText(event.message.content).trim();
    }
  });
  return { getText: () => text, unsubscribe };
}

/** Get the terminal assistant message without falling back to earlier turns. */
function getTerminalAssistantMessage(
  session: AgentSession,
  invocationStart: number,
): AssistantMessage | undefined {
  for (let index = session.messages.length - 1; index >= invocationStart; index--) {
    const msg = session.messages[index];
    if (msg?.role === "assistant") return msg;
  }
  return undefined;
}

function getTerminalAssistantText(
  session: AgentSession,
  invocationStart: number,
): string | undefined {
  const message = getTerminalAssistantMessage(session, invocationStart);
  return message ? extractText(message.content).trim() : undefined;
}

/** Pi resolves session.prompt() after terminal provider errors; preserve their actual cause. */
function throwTerminalAssistantError(session: AgentSession, invocationStart: number): void {
  const message = getTerminalAssistantMessage(session, invocationStart);
  if (message?.stopReason === "error") {
    throw new Error(message.errorMessage?.trim() || "Agent failed without provider error details.");
  }
}

/**
 * Wire an AbortSignal to abort a session.
 * Returns a cleanup function to remove the listener.
 */
function forwardAbortSignal(
  session: AgentSession,
  signal?: AbortSignal,
  onAbort?: () => void,
): () => void {
  if (!signal) return () => {};
  if (signal.aborted) {
    onAbort?.();
    void session.abort();
    return () => {};
  }
  const listener = () => {
    onAbort?.();
    void session.abort();
  };
  signal.addEventListener("abort", listener, { once: true });
  return () => signal.removeEventListener("abort", listener);
}

export async function runAgent(
  parentSource: ParentSnapshot | ExtensionContext,
  type: SubagentType,
  prompt: string,
  options: RunOptions,
): Promise<RunResult> {
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
  const extensionPaths = noExtensions ? [] : agentConfig.extensions.map((path) => resolve(path));
  const allowedExtensionPaths = new Set(extensionPaths);
  const extensionsOverride = noExtensions
    ? undefined
    : (base: LoadExtensionsResult): LoadExtensionsResult => ({
        ...base,
        extensions: base.extensions.filter((extension) =>
          allowedExtensionPaths.has(resolve(extension.path)),
        ),
      });
  const toolNames = [...agentConfig.builtinToolNames];
  const systemPrompt = buildAgentPrompt(agentConfig, effectiveCwd, env, parent.systemPrompt);

  const agentDir = getAgentDir();

  // Embedded roles load only this extension, which provides MessageAgent and
  // the parent-mediated bash gate. Isolated RPC spawns load no extensions.
  const loader = new DefaultResourceLoader({
    cwd: configCwd,
    agentDir,
    noExtensions,
    additionalExtensionPaths: extensionPaths.length > 0 ? extensionPaths : undefined,
    extensionsOverride,
    eventBus: createSubagentEventBus(options.pi.events),
    noSkills: options.isolated === true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => systemPrompt,
    appendSystemPromptOverride: () => [],
  });

  await runAsSubagent(type, () => loader.reload());
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
  const allowedTools = [
    ...new Set([
      ...toolNames,
      ...extensionToolNames.filter((name) => !EXCLUDED_TOOL_NAMES.includes(name)),
      SUBAGENT_TOOL_NAMES.MESSAGE_AGENT,
    ]),
  ];

  const settingsManager = SettingsManager.create(configCwd, agentDir);
  const sessionManager = SessionManager.inMemory(effectiveCwd);

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
    tools: allowedTools,
    customTools: [createMessageAgent(SUBAGENT_TOOL_NAMES.MESSAGE_AGENT, options.messageParent)],
    resourceLoader: loader,
  };
  if (thinkingLevel) {
    sessionOpts.thinkingLevel = thinkingLevel;
  }

  const { session } = await createAgentSession(sessionOpts);
  if (options.signal?.aborted) await agentSession.shutdownCancelledAgentSession(session);

  if (options.autoCompactionThreshold !== undefined)
    installTurnBoundaryAutoCompaction(session, options.autoCompactionThreshold);

  let requestIndex = 0;
  let activeRequestIndex: number | undefined, activeRequestStartedAt: number | undefined;
  const httpIdleTimeoutMs = session.settingsManager.getHttpIdleTimeoutMs();
  const providerRetrySettings = session.settingsManager.getProviderRetrySettings();
  const effectiveProviderTimeoutMs =
    providerRetrySettings.timeoutMs ??
    (httpIdleTimeoutMs === 0 ? 2_147_483_647 : httpIdleTimeoutMs);
  const observedAgentSignals = new WeakSet<AbortSignal>();
  const reportAgentSignalAbort = (signal: AbortSignal) => {
    emitDiagnostic(options.onDiagnostic, "agent_signal_abort", {
      request_index: activeRequestIndex,
      reason: abortReason(signal),
      ...(signal.reason === undefined ? {} : errorInfo(signal.reason)),
      manager_signal_aborted: options.signal?.aborted ?? false,
      manager_abort_reason: abortReason(options.signal),
    });
  };
  const priorOnPayload = session.agent.onPayload;
  const priorOnResponse = session.agent.onResponse;
  session.agent.onPayload = async (payload, requestModel) => {
    const transformed = priorOnPayload ? await priorOnPayload(payload, requestModel) : payload;
    activeRequestIndex = ++requestIndex;
    activeRequestStartedAt = Date.now();
    observeAbortSignal(session.agent.signal, observedAgentSignals, reportAgentSignalAbort);
    emitDiagnostic(options.onDiagnostic, "provider_request", {
      request_index: activeRequestIndex,
      provider: requestModel.provider,
      model: requestModel.id,
      api: requestModel.api,
      effective_timeout_ms: effectiveProviderTimeoutMs,
      timeout_deadline: activeRequestStartedAt + effectiveProviderTimeoutMs,
      ...summarizeProviderPayload(transformed === undefined ? payload : transformed),
    });
    return transformed;
  };
  session.agent.onResponse = async (response, responseModel) => {
    emitDiagnostic(options.onDiagnostic, "provider_response", {
      request_index: activeRequestIndex,
      provider: responseModel.provider,
      model: responseModel.id,
      ...summarizeProviderResponse(response),
      ...(activeRequestStartedAt === undefined
        ? {}
        : { elapsed_ms: Date.now() - activeRequestStartedAt }),
    });
    await priorOnResponse?.(response, responseModel);
  };

  sessionManager.appendCustomEntry(SUBAGENT_METADATA_ENTRY, {
    agentId: options.agentId,
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
  emitDiagnostic(options.onDiagnostic, "session_created", {
    session_id: session.sessionManager.getSessionId(),
    provider: session.model?.provider,
    model: session.model?.id,
    api: session.model?.api,
    thinking: session.thinkingLevel,
    transport: session.settingsManager.getTransport(),
    retry: session.settingsManager.getRetrySettings(),
    provider_retry: providerRetrySettings,
    http_idle_timeout_ms: httpIdleTimeoutMs,
    effective_provider_timeout_ms: effectiveProviderTimeoutMs,
    websocket_connect_timeout_ms: session.settingsManager.getWebSocketConnectTimeoutMs(),
    compaction: session.settingsManager.getCompactionSettings(),
  });

  options.onSessionCreated?.(session);

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
    if (event.type === "compaction_end" && !event.aborted && event.result) {
      options.onCompaction?.({ reason: event.reason, tokensBefore: event.result.tokensBefore });
    }
    recordSessionDiagnostic(session, event, options, {
      requestIndex: activeRequestIndex,
      requestStartedAt: activeRequestStartedAt,
    });
  });

  const collector = collectResponseText(session);
  const cleanupAbort = forwardAbortSignal(session, options.signal, () => {
    emitDiagnostic(options.onDiagnostic, "manager_signal_abort", {
      reason: abortReason(options.signal),
      request_index: activeRequestIndex,
    });
  });

  const invocationStart = session.messages.length;
  emitDiagnostic(options.onDiagnostic, "prompt_start", {
    invocation_start: invocationStart,
    prompt_bytes: Buffer.byteLength(prompt, "utf8"),
  });
  try {
    if (options.signal?.aborted) await agentSession.shutdownCancelledAgentSession(session);
    await session.prompt(prompt);
    emitDiagnostic(options.onDiagnostic, "prompt_resolved", {
      request_count: requestIndex,
      manager_signal_aborted: options.signal?.aborted ?? false,
    });
  } catch (error) {
    emitDiagnostic(options.onDiagnostic, "prompt_rejected", {
      ...errorInfo(error),
      request_count: requestIndex,
      manager_signal_aborted: options.signal?.aborted ?? false,
      manager_abort_reason: abortReason(options.signal),
    });
    throw error;
  } finally {
    unsubTurns();
    collector.unsubscribe();
    cleanupAbort();
  }

  throwTerminalAssistantError(session, invocationStart);
  const responseText =
    collector.getText() ?? getTerminalAssistantText(session, invocationStart) ?? "";
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
    onAssistantUsage?: (usage: AssistantUsage) => void;
    onCompaction?: (info: {
      reason: "manual" | "threshold" | "overflow";
      tokensBefore: number;
    }) => void;
    onDiagnostic?: (event: string, details?: Record<string, unknown>) => void;
    onAssistantFailure?: (failure: AgentFailure) => void;
    signal?: AbortSignal;
  } = {},
): Promise<string> {
  const collector = collectResponseText(session);
  const cleanupAbort = forwardAbortSignal(session, options.signal);

  const unsubEvents =
    options.onToolActivity ||
    options.onAssistantUsage ||
    options.onCompaction ||
    options.onDiagnostic ||
    options.onAssistantFailure
      ? session.subscribe((event: AgentSessionEvent) => {
          dispatchToolActivity(event, options.onToolActivity);
          if (event.type === "message_end" && event.message.role === "assistant") {
            options.onAssistantUsage?.(getAssistantUsage(event.message));
          }
          if (event.type === "compaction_end" && !event.aborted && event.result) {
            options.onCompaction?.({
              reason: event.reason,
              tokensBefore: event.result.tokensBefore,
            });
          }
          recordSessionDiagnostic(session, event, options, { resumed: true });
        })
      : () => {};

  const invocationStart = session.messages.length;
  emitDiagnostic(options.onDiagnostic, "resume_prompt_start", {
    invocation_start: invocationStart,
    prompt_bytes: Buffer.byteLength(prompt, "utf8"),
  });
  try {
    await session.prompt(prompt);
    emitDiagnostic(options.onDiagnostic, "resume_prompt_resolved", {
      manager_signal_aborted: options.signal?.aborted ?? false,
    });
  } catch (error) {
    emitDiagnostic(options.onDiagnostic, "resume_prompt_rejected", {
      ...errorInfo(error),
      manager_signal_aborted: options.signal?.aborted ?? false,
      manager_abort_reason: abortReason(options.signal),
    });
    throw error;
  } finally {
    collector.unsubscribe();
    unsubEvents();
    cleanupAbort();
  }

  throwTerminalAssistantError(session, invocationStart);
  return collector.getText() ?? getTerminalAssistantText(session, invocationStart) ?? "";
}

/**
 * Send a steering message to a running subagent.
 * The message is consumed after the current assistant response's tool-call batch.
 */
export async function steerAgent(session: AgentSession, message: string): Promise<void> {
  await session.steer(message);
}

/**
 * Get the subagent's conversation messages as formatted text.
 */
export function getAgentConversation(session: AgentSession): string {
  const parts: string[] = [];

  for (const msg of session.messages) {
    if (msg.role === "user") {
      const text = typeof msg.content === "string" ? msg.content : extractText(msg.content);
      if (text.trim()) parts.push(`[User]: ${text.trim()}`);
    } else if (msg.role === "assistant") {
      const textParts: string[] = [];
      const toolCalls: string[] = [];
      for (const c of msg.content) {
        if (c.type === "text" && c.text) textParts.push(c.text);
        else if (c.type === "toolCall") toolCalls.push(`  Tool: ${getToolCallName(c)}`);
      }
      if (textParts.length > 0) parts.push(`[Assistant]: ${textParts.join("\n")}`);
      if (toolCalls.length > 0) parts.push(`[Tool Calls]:\n${toolCalls.join("\n")}`);
    } else if (msg.role === "toolResult") {
      const text = extractText(msg.content);
      const truncated = text.length > 200 ? text.slice(0, 200) + "..." : text;
      parts.push(`[Tool Result (${msg.toolName})]: ${truncated}`);
    }
  }

  return parts.join("\n\n");
}
