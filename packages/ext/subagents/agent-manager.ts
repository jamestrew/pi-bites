/**
 * agent-manager.ts — Tracks concurrent agents, queued execution, and resume support.
 *
 * Agents are subject to a configurable concurrency limit (default: 4).
 * Excess agents are queued and auto-started as running agents complete.
 */

import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resumeAgent, runAgent, type ToolActivity } from "./agent-runner.js";
import { shutdownAgentSession } from "./agent-session-shutdown.js";
import { resolveAgent } from "./agent-types.js";
import { appendSubagentDiagnostic, serializeDiagnosticError } from "./diagnostics.js";
import { snapshotParent, type ParentSnapshot } from "./parent-snapshot.js";
import type { SubagentSender } from "./subagent-messages.js";
import { formatToolCall, summarizeToolArg } from "./ui/tool-call-format.js";
import { MISSING_FINAL_RESPONSE_ERROR } from "./types.js";
import type { AgentInvocation, AgentRecord, SubagentType, ThinkingLevel } from "./types.js";
import { addUsage, appendSubagentUsageRecord, type AssistantUsage } from "./usage.js";

export type OnAgentComplete = (record: AgentRecord) => void;
export type OnAgentStart = (record: AgentRecord) => void;
export type OnAgentCompact = (record: AgentRecord, info: CompactionInfo) => void;
export type MessageParent = (
  parentSessionId: string,
  sender: SubagentSender,
  message: string,
) => boolean;
export type CompactionInfo = { reason: "manual" | "threshold" | "overflow"; tokensBefore: number };

/** Default max concurrent agents. */
const DEFAULT_MAX_CONCURRENT = 4;
export const MAX_RETAINED_TOOL_CALLS = 200;

/**
 * Validate a caller-supplied SpawnOptions.cwd. `undefined`/`null` mean "unset"
 * (parent cwd). Anything else must be an absolute path to an existing
 * directory — curated errors instead of TypeErrors from path/fs internals
 * (RPC callers send arbitrary JSON: null, numbers, file paths).
 */
function assertValidSpawnCwd(cwd: unknown): asserts cwd is string | undefined | null {
  if (cwd == null) return;
  if (typeof cwd !== "string") {
    throw new Error(`SpawnOptions.cwd must be an absolute path`);
  }
  if (!isAbsolute(cwd)) {
    throw new Error(`SpawnOptions.cwd must be an absolute path: "${cwd}"`);
  }
  let isDirectory = false;
  try {
    isDirectory = statSync(cwd).isDirectory();
  } catch {
    throw new Error(`SpawnOptions.cwd does not exist: "${cwd}"`);
  }
  if (!isDirectory) {
    throw new Error(`SpawnOptions.cwd is not a directory: "${cwd}"`);
  }
}

interface SpawnArgs {
  pi: ExtensionAPI;
  parent: ParentSnapshot;
  type: SubagentType;
  prompt: string;
  options: SpawnOptions;
}

export interface SpawnOptions {
  description: string;
  model?: Model<Api>;
  isolated?: boolean;
  thinkingLevel?: ThinkingLevel;
  /**
   * Working directory for the agent (absolute path). Default: parent session
   * cwd. The agent's tools operate here, but .pi config (extensions, skills,
   * settings) still loads from the parent session's project — the
   * target directory's `.pi` extensions never execute.
   */
  cwd?: string;
  /** Resolved invocation snapshot captured for UI display. */
  invocation?: AgentInvocation;
  /** Called on tool start/end with activity info (for streaming progress to UI). */
  onToolActivity?: (activity: ToolActivity) => void;
  /** Called on streaming text deltas from the assistant response. */
  onTextDelta?: (delta: string, fullText: string) => void;
  /** Called when the agent session is created (for accessing session stats). */
  onSessionCreated?: (session: AgentSession) => void;
  /** Called at the end of each agentic turn with the cumulative count. */
  onTurnEnd?: (turnCount: number) => void;
  /** Called once per assistant message_end with that message's usage delta. */
  onAssistantUsage?: (usage: AssistantUsage) => void;
  /** Called when the session successfully compacts. */
  onCompaction?: (info: CompactionInfo) => void;
}

export class AgentManager {
  private agents = new Map<string, AgentRecord>();
  private cleanupInterval: ReturnType<typeof setInterval>;
  private onComplete?: OnAgentComplete;
  private onStart?: OnAgentStart;
  private onCompact?: OnAgentCompact;
  private messageParent?: MessageParent;
  private getAutoCompactionThreshold?: () => number | undefined;
  private maxConcurrent: number;
  /** Queue of agents waiting to start. */
  private queue: { id: string; args: SpawnArgs }[] = [];
  /** Number of currently running agents. */
  private runningCount = 0;
  private completed = new WeakSet<AgentRecord>();
  private releasedSlots = new WeakSet<AgentRecord>();
  private settled = new WeakSet<AgentRecord>();
  private pendingAgents = new Set<Promise<string>>();
  private teardowns = new Set<Promise<void>>();
  private closing = false;
  private disposed = false;
  private shutdownPromise?: Promise<void>;

  constructor(
    onComplete?: OnAgentComplete,
    maxConcurrent = DEFAULT_MAX_CONCURRENT,
    onStart?: OnAgentStart,
    onCompact?: OnAgentCompact,
    messageParent?: MessageParent,
    getAutoCompactionThreshold?: () => number | undefined,
  ) {
    this.onComplete = onComplete;
    this.onStart = onStart;
    this.onCompact = onCompact;
    this.messageParent = messageParent;
    this.getAutoCompactionThreshold = getAutoCompactionThreshold;
    this.maxConcurrent = maxConcurrent;
    // Cleanup completed agents after 10 minutes (but keep sessions for resume)
    this.cleanupInterval = setInterval(() => this.cleanup(), 60_000);
    this.cleanupInterval.unref();
  }

  private notifyComplete(record: AgentRecord): void {
    if (this.completed.has(record)) return;
    this.completed.add(record);
    try {
      this.onComplete?.(record);
    } catch {
      /* completion side effects must not change agent state */
    }
  }

  private releaseSlot(record: AgentRecord): void {
    if (this.releasedSlots.has(record)) return;
    this.releasedSlots.add(record);
    this.runningCount--;
    this.drainQueue();
  }

  private teardownSession(session: AgentSession): Promise<void> {
    const teardown = shutdownAgentSession(session);
    if (!this.teardowns.has(teardown)) {
      this.teardowns.add(teardown);
      void teardown.then(
        () => this.teardowns.delete(teardown),
        () => this.teardowns.delete(teardown),
      );
    }
    return teardown;
  }

  private async waitForTeardowns(): Promise<void> {
    while (this.teardowns.size > 0) {
      await Promise.allSettled(this.teardowns);
    }
  }

  private recordAssistantUsage(
    record: AgentRecord,
    usage: AssistantUsage,
    model?: Model<Api>,
    callback?: (usage: AssistantUsage) => void,
  ): void {
    addUsage(record.lifetimeUsage, usage);
    appendSubagentUsageRecord({
      type: "subagent_usage",
      subagent: record.type,
      sessionId: record.id,
      parentSessionId: record.parentSessionId,
      timestamp: usage.timestamp ?? Date.now(),
      provider: usage.provider ?? model?.provider ?? "unknown",
      model: usage.model ?? model?.id ?? "unknown",
      usage: {
        input: usage.input,
        output: usage.output,
        cacheRead: usage.cacheRead ?? 0,
        cacheWrite: usage.cacheWrite,
        cost: { total: usage.cost ?? 0 },
      },
    }).catch(() => undefined);
    callback?.(usage);
  }

  private recordDiagnostic(
    record: AgentRecord,
    event: string,
    details?: Record<string, unknown>,
  ): void {
    appendSubagentDiagnostic({
      type: "subagent_diagnostic",
      version: 1,
      timestamp: Date.now(),
      event,
      agentId: record.id,
      parentSessionId: record.parentSessionId,
      subagent: record.type,
      pid: process.pid,
      ...(record.invocation?.modelName
        ? {
            provider: record.invocation.modelName.split("/", 1)[0],
            model: record.invocation.modelName.includes("/")
              ? record.invocation.modelName.slice(record.invocation.modelName.indexOf("/") + 1)
              : record.invocation.modelName,
          }
        : {}),
      ...(record.invocation?.thinking ? { thinking: record.invocation.thinking } : {}),
      ...(details ? { details } : {}),
    }).catch(() => undefined);
  }

  private recordFailure(record: AgentRecord, failure: AgentRecord["failureHistory"][number]): void {
    record.failureHistory.push(failure);
    this.recordDiagnostic(record, "failure_observed", { ...failure });
  }

  /** Update the max concurrent agents limit. */
  setMaxConcurrent(n: number) {
    this.maxConcurrent = Math.max(1, n);
    // Start queued agents if the new limit allows
    this.drainQueue();
  }

  getMaxConcurrent(): number {
    return this.maxConcurrent;
  }

  /**
   * Spawn an agent and return its ID immediately.
   * If the concurrency limit is reached, the agent is queued.
   */
  spawn(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    requestedType: string,
    prompt: string,
    options: SpawnOptions,
  ): string {
    if (this.closing) throw new Error("AgentManager is shutting down.");
    const { type } = resolveAgent(requestedType);
    // Validate before the queue branch — a queued spawn should fail at the
    // call, not minutes later at drain. Throw (not warn): programmatic callers
    // can fix and retry; the RPC layer converts throws into error envelopes.
    assertValidSpawnCwd(options.cwd);

    const id = randomUUID().slice(0, 17);
    const parent = snapshotParent(ctx);
    const abortController = new AbortController();
    const record: AgentRecord = {
      id,
      type,
      parentSessionId: parent.sessionId,
      prompt,
      description: options.description,
      status: "queued",
      toolUses: 0,
      toolCalls: [],
      omittedToolCalls: 0,
      startedAt: Date.now(),
      abortController,
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
      compactionCount: 0,
      invocation: options.invocation,
      failureHistory: [],
    };
    this.agents.set(id, record);
    this.recordDiagnostic(record, "created", {
      manager_running_count: this.runningCount,
      manager_queue_length: this.queue.length,
      manager_max_concurrent: this.maxConcurrent,
    });

    const args: SpawnArgs = { pi, parent, type, prompt, options };

    if (this.runningCount >= this.maxConcurrent) {
      // Queue it — will be started when a running agent completes
      this.queue.push({ id, args });
    } else {
      // startAgent can throw — clean up the record so callers don't see an
      // orphan in `listAgents()`.
      try {
        this.startAgent(id, record, args);
      } catch (err) {
        this.recordFailure(record, {
          timestamp: Date.now(),
          phase: "manager",
          message: err instanceof Error ? err.message : String(err),
          ...(err instanceof Error ? { name: err.name } : {}),
          error_details: serializeDiagnosticError(err),
          manager_signal_aborted: abortController.signal.aborted,
        });
        this.recordDiagnostic(record, "start_rejected", {
          error: serializeDiagnosticError(err),
        });
        this.agents.delete(id);
        throw err;
      }
    }

    pi.events.emit("subagents:created", {
      id,
      type,
      description: record.description,
    });
    return id;
  }

  /** Actually start an agent (called immediately or from queue drain). */
  private startAgent(
    id: string,
    record: AgentRecord,
    { pi, parent, type, prompt, options }: SpawnArgs,
  ) {
    // Re-validate a caller-supplied cwd: queued spawns can start minutes after
    // spawn()'s check, and the directory may be gone by then (TOCTOU). Same
    // curated errors; drainQueue parks a throw on the record as an error.
    assertValidSpawnCwd(options.cwd);
    const customCwd = options.cwd ?? undefined; // null (RPC "unset") → undefined

    record.status = "running";
    const queuedAt = record.startedAt;
    record.startedAt = Date.now();
    this.runningCount++;
    this.onStart?.(record);
    this.recordDiagnostic(record, "started", {
      cwd: customCwd ?? parent.cwd,
      isolated: options.isolated === true,
      queue_duration_ms: record.startedAt - queuedAt,
      manager_running_count: this.runningCount,
      manager_queue_length: this.queue.length,
      manager_max_concurrent: this.maxConcurrent,
    });

    const abortController = record.abortController;
    if (!abortController) throw new Error(`Agent ${id} has no abort controller`);
    const onToolActivity = (activity: ToolActivity) => {
      if (activity.type === "end") record.toolUses++;
      if (activity.type === "call") {
        if (record.toolCalls.length >= MAX_RETAINED_TOOL_CALLS) {
          record.toolCalls.shift();
          record.omittedToolCalls++;
        }
        record.toolCalls.push(
          summarizeToolArg(formatToolCall(activity.toolName, activity.arguments ?? {})),
        );
      }
      options.onToolActivity?.(activity);
    };

    const promise = runAgent(parent, type, prompt, {
      pi,
      agentId: id,
      model: options.model,
      isolated: options.isolated,
      thinkingLevel: options.thinkingLevel,
      autoCompactionThreshold: this.getAutoCompactionThreshold?.(),
      cwd: customCwd,
      configCwd: customCwd !== undefined ? parent.cwd : undefined,
      signal: abortController.signal,
      messageParent: (message) =>
        this.messageParent?.(
          parent.sessionId,
          {
            id,
            type,
            title: options.description,
            ...(options.invocation?.modelName ? { model_name: options.invocation.modelName } : {}),
            ...(options.invocation?.thinking ? { thinking: options.invocation.thinking } : {}),
          },
          message,
        ) ?? false,
      onToolActivity,
      onTurnEnd: options.onTurnEnd,
      onTextDelta: options.onTextDelta,
      onAssistantUsage: (usage) => {
        this.recordAssistantUsage(record, usage, options.model, options.onAssistantUsage);
      },
      onDiagnostic: (event, details) => this.recordDiagnostic(record, event, details),
      onAssistantFailure: (failure) => this.recordFailure(record, failure),
      onCompaction: (info) => {
        record.compactionCount++;
        this.onCompact?.(record, info);
        options.onCompaction?.(info);
      },
      onSessionCreated: (session) => {
        record.session = session;
        if (abortController.signal.aborted) {
          void this.teardownSession(session);
          return;
        }
        // Flush any steers that arrived before the session was ready
        if (record.pendingSteers?.length) {
          for (const msg of record.pendingSteers) {
            session.steer(msg).catch(() => {});
          }
          record.pendingSteers = undefined;
        }
        options.onSessionCreated?.(session);
      },
    })
      .then(async ({ responseText, session }) => {
        if (record.pendingCancelSteer && record.status !== "stopped") {
          const message = record.pendingCancelSteer;
          record.pendingCancelSteer = undefined;
          record.status = "running";
          responseText = await resumeAgent(session, message, {
            onToolActivity,
            onAssistantUsage: (usage) => {
              this.recordAssistantUsage(record, usage, options.model, options.onAssistantUsage);
            },
            onCompaction: (info) => {
              record.compactionCount++;
              this.onCompact?.(record, info);
              options.onCompaction?.(info);
            },
            onDiagnostic: (event, details) => this.recordDiagnostic(record, event, details),
            onAssistantFailure: (failure) => this.recordFailure(record, failure),
          });
        }

        // Don't overwrite status if externally stopped via abort().
        if (record.status !== "stopped") {
          if (responseText.trim()) {
            record.status = "completed";
            record.result = responseText;
          } else {
            record.status = "error";
            record.error = MISSING_FINAL_RESPONSE_ERROR;
            record.result = undefined;
          }
        } else if (responseText.trim()) {
          record.result = responseText;
        }
        record.session = session;
        record.completedAt ??= Date.now();

        this.settled.add(record);
        this.recordDiagnostic(record, "completed", {
          status: record.status,
          duration_ms: (record.completedAt ?? Date.now()) - record.startedAt,
          tool_uses: record.toolUses,
          lifetime_usage: record.lifetimeUsage,
          compaction_count: record.compactionCount,
          failure_count: record.failureHistory.length,
          abort: record.abort,
        });
        this.releaseSlot(record);
        this.notifyComplete(record);
        return responseText;
      })
      .catch((err) => {
        // Don't overwrite status if externally stopped via abort()
        if (record.status !== "stopped") {
          record.status = "error";
        }
        record.error = err instanceof Error ? err.message : String(err);
        this.recordFailure(record, {
          timestamp: Date.now(),
          phase: "manager",
          message: record.error,
          ...(err instanceof Error ? { name: err.name } : {}),
          error_details: serializeDiagnosticError(err),
          manager_signal_aborted: abortController.signal.aborted,
        });
        record.completedAt ??= Date.now();

        this.settled.add(record);
        this.recordDiagnostic(record, "completed", {
          status: record.status,
          error: record.error,
          duration_ms: record.completedAt - record.startedAt,
          tool_uses: record.toolUses,
          lifetime_usage: record.lifetimeUsage,
          compaction_count: record.compactionCount,
          failure_count: record.failureHistory.length,
          abort: record.abort,
        });
        this.releaseSlot(record);
        this.notifyComplete(record);
        return "";
      });

    record.promise = promise;
    this.pendingAgents.add(promise);
    void promise.then(
      () => this.pendingAgents.delete(promise),
      () => this.pendingAgents.delete(promise),
    );
  }

  /** Start queued agents up to the concurrency limit. */
  private drainQueue() {
    while (this.queue.length > 0 && this.runningCount < this.maxConcurrent) {
      const next = this.queue.shift();
      if (!next) break;
      const record = this.agents.get(next.id);
      if (!record || record.status !== "queued") continue;
      try {
        this.startAgent(next.id, record, next.args);
      } catch (err) {
        // Surface late failures on the record so the user/agent can see them
        // via /agents, then keep draining.
        record.status = "error";
        record.error = err instanceof Error ? err.message : String(err);
        record.completedAt = Date.now();
        this.recordFailure(record, {
          timestamp: Date.now(),
          phase: "manager",
          message: record.error,
          ...(err instanceof Error ? { name: err.name } : {}),
          error_details: serializeDiagnosticError(err),
          manager_signal_aborted: record.abortController?.signal.aborted ?? false,
        });
        this.recordDiagnostic(record, "completed", {
          status: record.status,
          error: record.error,
          duration_ms: record.completedAt - record.startedAt,
          failure_count: record.failureHistory.length,
        });
        this.notifyComplete(record);
      }
    }
  }

  /**
   * Send a message to an agent from the UI (mirrors the MessageAgent tool).
   * A live session queues it for the boundary after the current assistant
   * response's tool-call batch, where it appears as a user message. If the
   * session isn't ready yet, the message is queued on `pendingSteers` and
   * flushed when the session is created. Returns false if the agent can't
   * accept steering (unknown id, or no longer running/queued).
   */
  steer(id: string, message: string): boolean {
    const record = this.agents.get(id);
    if (!record || (record.status !== "running" && record.status !== "queued")) return false;
    if (record.session) {
      record.session.steer(message).catch(() => {});
    } else {
      if (!record.pendingSteers) record.pendingSteers = [];
      record.pendingSteers.push(message);
    }
    return true;
  }

  cancelAndSteer(id: string, message: string): boolean {
    const record = this.agents.get(id);
    if (!record?.session || record.status !== "running") return false;
    record.pendingCancelSteer = message;
    record.abort = {
      timestamp: Date.now(),
      source: "cancel_and_steer",
      reason: "cancel_and_steer",
    };
    this.recordDiagnostic(record, "abort_requested", { source: "cancel_and_steer" });
    record.session.abort().catch(() => {});
    return true;
  }

  getRecord(id: string): AgentRecord | undefined {
    return this.agents.get(id);
  }

  listAgents(): AgentRecord[] {
    return [...this.agents.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  abort(id: string): boolean {
    const record = this.agents.get(id);
    if (!record) return false;

    // Remove from queue if queued
    if (record.status === "queued") {
      this.queue = this.queue.filter((q) => q.id !== id);
      record.status = "stopped";
      record.completedAt = Date.now();
      record.abort = { timestamp: Date.now(), source: "stop", reason: "stop" };
      this.recordDiagnostic(record, "abort_requested", { source: "stop", queued: true });
      this.recordDiagnostic(record, "completed", {
        status: record.status,
        duration_ms: record.completedAt - record.startedAt,
        abort: record.abort,
      });
      this.notifyComplete(record);
      return true;
    }

    if (record.status !== "running") return false;
    record.status = "stopped";
    record.error = "aborted";
    record.completedAt = Date.now();
    record.abort = { timestamp: Date.now(), source: "stop", reason: "stop" };
    this.recordDiagnostic(record, "abort_requested", { source: "stop" });
    record.abortController?.abort(record.abort.reason);
    this.releaseSlot(record);
    this.notifyComplete(record);
    return true;
  }

  private canRemove(record: AgentRecord): boolean {
    return !record.promise || this.settled.has(record);
  }

  /** Dispose a record's session and remove it from the map. */
  private removeRecord(id: string, record: AgentRecord): void {
    if (record.session) void this.teardownSession(record.session);
    record.session = undefined;
    this.agents.delete(id);
  }

  private cleanup() {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [id, record] of this.agents) {
      if (record.status === "running" || record.status === "queued") continue;
      if ((record.completedAt ?? 0) >= cutoff || !this.canRemove(record)) continue;
      this.removeRecord(id, record);
    }
  }

  /** Remove terminal records whose child promises have settled. */
  clearCompleted(): void {
    for (const [id, record] of this.agents) {
      if (record.status === "running" || record.status === "queued" || !this.canRemove(record))
        continue;
      this.removeRecord(id, record);
    }
  }

  /** Whether any agents are still running or queued. */
  hasRunning(): boolean {
    return [...this.agents.values()].some((r) => r.status === "running" || r.status === "queued");
  }

  /** Abort all running and queued agents immediately. */
  abortAll(): number {
    let count = 0;
    // Clear queued agents first
    for (const queued of this.queue) {
      const record = this.agents.get(queued.id);
      if (record) {
        record.status = "stopped";
        record.completedAt = Date.now();
        record.abort = { timestamp: Date.now(), source: "shutdown", reason: "shutdown" };
        this.recordDiagnostic(record, "abort_requested", { source: "shutdown", queued: true });
        this.recordDiagnostic(record, "completed", {
          status: record.status,
          duration_ms: record.completedAt - record.startedAt,
          abort: record.abort,
        });
        count++;
      }
    }
    this.queue = [];
    // Abort running agents
    for (const record of this.agents.values()) {
      if (record.status === "running") {
        record.abort = { timestamp: Date.now(), source: "shutdown", reason: "shutdown" };
        this.recordDiagnostic(record, "abort_requested", { source: "shutdown" });
        record.abortController?.abort(record.abort.reason);
        record.status = "stopped";
        record.completedAt = Date.now();
        count++;
      }
    }
    return count;
  }

  /** Wait for every started agent to settle, including agents cancelled during shutdown. */
  async waitForAll(): Promise<void> {
    // Loop because drainQueue respects the concurrency limit — as running
    // agents finish they start queued ones, which need awaiting too.
    for (;;) {
      this.drainQueue();
      if (this.pendingAgents.size === 0) break;
      await Promise.allSettled(this.pendingAgents);
    }
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.closing = true;
    this.shutdownPromise = Promise.resolve().then(() => this.finishShutdown());
    return this.shutdownPromise;
  }

  private async finishShutdown(): Promise<void> {
    this.abortAll();
    await this.waitForAll();
    for (const record of this.agents.values()) {
      if (record.session) void this.teardownSession(record.session);
    }
    await this.waitForTeardowns();
    this.finalizeDispose();
    await this.waitForTeardowns();
  }

  dispose(): Promise<void> {
    return this.shutdown();
  }

  private finalizeDispose(): void {
    if (this.disposed) return;
    this.closing = true;
    this.disposed = true;
    clearInterval(this.cleanupInterval);
    this.abortAll();
    for (const record of this.agents.values()) {
      if (record.session) void this.teardownSession(record.session);
    }
    this.agents.clear();
  }
}
