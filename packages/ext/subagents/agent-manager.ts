import { TaskPaths } from "./task-paths.js";
import { AgentTree, getAgentSessionId } from "./agent-tree.js";
import type { RegisterCollaboration } from "./subagent-context.js";
import type { SubagentContext } from "./operation-context.js";
import { randomUUID } from "node:crypto";
import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AgentCloser, type ClosedAgentRecord } from "./agent-close.js";
import { AgentReopener, type ReopenOptions } from "./agent-reopen.js";
import { AgentInterrupter } from "./agent-interruption.js";
import { resumeAgent, runAgent, steerAgent, type ToolActivity } from "./agent-runner.js";
import { AgentRuntimes } from "./agent-runtimes.js";
import { resolveAgent } from "./agent-types.js";
import {
  appendSubagentDiagnostic,
  agentDiagnostic,
  serializeDiagnosticError,
} from "./diagnostics.js";
import { snapshotParent, type ParentSnapshot } from "./parent-snapshot.js";
import { assertValidSpawnCwd } from "./spawn-cwd.js";
import type { SubagentSender } from "./subagent-messages.js";
import { formatToolCall, summarizeToolArg } from "./ui/tool-call-format.js";
import { MISSING_FINAL_RESPONSE_ERROR } from "./types.js";
import type { AgentRecord, SubagentType, SpawnOptions } from "./types.js";
import { recordAssistantUsage, type AssistantUsage } from "./usage.js";

export type OnAgentComplete = (record: AgentRecord, generation: number) => void;
export type OnAgentStart = (record: AgentRecord) => void;
export type OnAgentCompact = (record: AgentRecord, info: CompactionInfo) => void;
export type MessageParent = (
  parentSessionId: string,
  sender: SubagentSender,
  message: string,
) => boolean;
export type CompactionInfo = { reason: "manual" | "threshold" | "overflow"; tokensBefore: number };

const DEFAULT_MAX_CONCURRENT = 6;
export const MAX_RETAINED_TOOL_CALLS = 200;

interface SpawnArgs {
  pi: ExtensionAPI;
  parent: ParentSnapshot;
  parentEntries?: ReturnType<ExtensionContext["sessionManager"]["buildContextEntries"]>;
  type: SubagentType;
  prompt: string;
  options: SpawnOptions;
}

interface QueuedTurn {
  id: string;
  generation: number;
  start: () => void;
}

interface TurnHooks {
  onToolActivity: (activity: ToolActivity) => void;
  onTurnEnd: (turnCount: number) => void;
  onTextDelta: (delta: string, fullText: string) => void;
  onAssistantUsage: (usage: AssistantUsage) => void;
  onCompaction: (info: CompactionInfo) => void;
  onDiagnostic: (event: string, details?: Record<string, unknown>) => void;
  onAssistantFailure: (failure: AgentRecord["failureHistory"][number]) => void;
}

export type { SpawnOptions } from "./types.js";

export class AgentManager {
  private agents = new Map<string, AgentRecord>();
  readonly taskPaths = new TaskPaths(() => this.listAgents());
  readonly tree = new AgentTree(this.agents, (id) => this.isClosing(id));
  private maxConcurrent: number;
  /** Queue of agents waiting to start. */
  private queue: QueuedTurn[] = [];
  /** Execution reservations; unnamed V1 agents retain theirs until close. */
  private reservedCount = 0;
  private reservations = new WeakSet<AgentRecord>();
  private closer: AgentCloser;
  private completedGeneration = new WeakMap<AgentRecord, number>();
  private settledGeneration = new WeakMap<AgentRecord, number>();
  private interruptions: AgentInterrupter;
  private options = new WeakMap<AgentRecord, SpawnOptions>();
  private turnCounts = new WeakMap<AgentRecord, number>();
  private followupPending = new WeakMap<AgentRecord, () => boolean>();
  private pendingAgents = new Set<Promise<string>>();
  onRuntimeLoaded?: (record: AgentRecord) => void;
  readonly runtimes = new AgentRuntimes({
    records: () => this.listAgents(),
    limit: () => this.maxConcurrent,
    getRecord: (id) => this.agents.get(id),
    isClosing: (id) => this.isClosing(id),
    isSettled: (record) => (this.settledGeneration.get(record) ?? 0) >= record.generation,
    retain: (record) => this.closer.retain(record),
    invalidate: (record) => this.onAgentInvalidated?.(record),
  });
  private reopener: AgentReopener;
  private closing = false;
  private shutdownPromise?: Promise<void>;

  constructor(
    private onComplete?: OnAgentComplete,
    maxConcurrent = DEFAULT_MAX_CONCURRENT,
    private onStart?: OnAgentStart,
    private onCompact?: OnAgentCompact,
    private messageParent?: MessageParent,
    private getAutoCompactionThreshold?: () => number | undefined,
    private onAgentInvalidated?: (record: AgentRecord) => void,
    private registerCollaboration?: (record: AgentRecord) => RegisterCollaboration,
  ) {
    this.maxConcurrent = maxConcurrent;
    this.interruptions = new AgentInterrupter({
      isSettled: (record, generation) => (this.settledGeneration.get(record) ?? 0) >= generation,
      onRequest: (record, source, generation) =>
        this.recordDiagnostic(record, "abort_requested", { source, generation }),
      onFailure: (record, error) => {
        this.recordFailure(record, {
          timestamp: Date.now(),
          phase: "manager",
          message: error instanceof Error ? error.message : String(error),
          ...(error instanceof Error ? { name: error.name } : {}),
          error_details: serializeDiagnosticError(error),
          manager_signal_aborted: record.abortController?.signal.aborted ?? false,
        });
      },
    });
    this.closer = new AgentCloser(this.agents, {
      invalidate: (record) => {
        this.onAgentInvalidated?.(record);
        void this.reopener.cancelChildren(getAgentSessionId(record));
      },
      abort: (id) => void this.abort(id),
      teardown: async (record) => {
        await this.reopener.cancelChildren(getAgentSessionId(record));
        await this.runtimes.pending(record.id);
        if (record.session) await this.runtimes.teardown(record.session);
      },
      releaseReservation: (record) => this.releaseReservation(record),
    });
    this.reopener = new AgentReopener(this.agents, this.closer, {
      assertOwnerAvailable: (parentId, rootId) => this.tree.assertOwnerAvailable(parentId, rootId),
      reserve: (record) => this.reserve(record),
      admitRuntime: (signal) => this.runtimes.admit(signal),
      release: (record) => this.releaseReservation(record),
      invalidate: (record) => this.onAgentInvalidated?.(record),
      commit: (record) => {
        this.options.set(record, {
          ...this.options.get(record),
          description: record.description,
          model: record.session?.model,
          thinkingLevel: record.invocation?.thinking,
          allowedTools: record.allowedTools,
        });
        this.runtimes.touch(record.id);
        try {
          this.onRuntimeLoaded?.(record);
        } catch {
          /* Display cannot revoke a loaded runtime. */
        }
      },
      registerCollaboration,
      autoCompactionThreshold: getAutoCompactionThreshold,
    });
  }

  private get runningCount(): number {
    return [...this.agents.values()].filter((record) => record.status === "running").length;
  }

  private notifyComplete(record: AgentRecord, generation = record.generation): void {
    if ((this.completedGeneration.get(record) ?? 0) >= generation) return;
    this.completedGeneration.set(record, generation);
    try {
      this.onComplete?.(record, generation);
    } catch {
      /* completion side effects must not change agent state */
    }
  }

  private notifyStart(record: AgentRecord): void {
    try {
      this.onStart?.(record);
    } catch {
      /* UI start side effects must not change turn accounting */
    }
  }

  private clearSessionQueue(session?: AgentSession): void {
    (session as Partial<AgentSession> | undefined)?.clearQueue?.();
  }

  private reserve(record: AgentRecord): boolean {
    if (this.reservations.has(record)) return true;
    if (this.reservedCount >= this.maxConcurrent) return false;
    this.reservations.add(record);
    this.reservedCount++;
    return true;
  }

  private releaseReservation(record: AgentRecord): void {
    if (!this.reservations.delete(record)) return;
    this.reservedCount--;
    this.drainQueue();
  }

  private recordDiagnostic(
    record: AgentRecord,
    event: string,
    details?: Record<string, unknown>,
  ): void {
    appendSubagentDiagnostic(agentDiagnostic(record, event, details)).catch(() => undefined);
  }

  private recordFailure(record: AgentRecord, failure: AgentRecord["failureHistory"][number]): void {
    record.failureHistory.push(failure);
    this.recordDiagnostic(record, "failure_observed", { ...failure });
  }

  setMaxConcurrent(n: number) {
    this.maxConcurrent = Math.max(1, n);
    this.drainQueue();
  }

  getMaxConcurrent(): number {
    return this.maxConcurrent;
  }

  /**
   * Spawn an agent and return its ID immediately.
   * Rejects at capacity unless the caller explicitly opts into queuing.
   */
  spawn(
    pi: ExtensionAPI,
    ctx: SubagentContext,
    requestedType: string,
    prompt: string,
    options: SpawnOptions,
  ): string {
    if (this.closing) throw new Error("AgentManager is shutting down.");
    this.tree.assertCanDelegate(ctx.sessionManager.getSessionId());
    const resolved = resolveAgent(requestedType);
    if (!requestedType.trim() || !resolved.matched)
      throw new Error(`Unknown agent type '${requestedType}'.`);
    const { type } = resolved;
    // Validate before the queue branch — a queued spawn should fail at the
    // call, not minutes later at drain. Throw (not warn): programmatic callers
    // can fix and retry; the RPC layer converts throws into error envelopes.
    assertValidSpawnCwd(options.cwd);
    if (!options.queueIfBusy && this.reservedCount >= this.maxConcurrent) {
      throw new Error("No concurrency slot is available. Close an agent before spawning another.");
    }

    const taskName =
      options.taskName === undefined
        ? undefined
        : this.taskPaths.available(ctx.sessionManager.getSessionId(), options.taskName);
    const id = randomUUID().slice(0, 17);
    const parent = snapshotParent(ctx);
    const parentEntries = options.forkContext
      ? structuredClone(ctx.sessionManager.buildContextEntries())
      : undefined;
    const abortController = new AbortController();
    const record: AgentRecord = {
      id,
      taskName,
      allowedTools: options.allowedTools && [...options.allowedTools],
      incarnation: randomUUID(),
      generation: 1,
      type,
      parentSessionId: parent.sessionId,
      rootSessionId: this.tree.rootSessionId(parent.sessionId),
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
    this.options.set(record, options);
    this.turnCounts.set(record, 0);
    this.recordDiagnostic(record, "created", {
      manager_running_count: this.runningCount,
      manager_queue_length: this.queue.length,
      manager_max_concurrent: this.maxConcurrent,
    });

    const args: SpawnArgs = { pi, parent, parentEntries, type, prompt, options };

    const start = () => this.startAgent(id, record, args);
    if (this.reservedCount >= this.maxConcurrent) {
      // Queue it — will be started when a retained agent releases its slot.
      this.queue.push({ id, generation: record.generation, start });
    } else {
      // startAgent can throw — clean up the record so callers don't see an
      // orphan in `listAgents()`.
      try {
        start();
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
        this.releaseReservation(record);
        this.agents.delete(id);
        throw err;
      }
    }

    pi.events.emit("subagents:created", {
      id,
      generation: record.generation,
      type,
      description: record.description,
    });
    return id;
  }

  private createTurnHooks(
    record: AgentRecord,
    options: SpawnOptions,
    generation: number,
    turnCountMode: "absolute" | "increment",
  ): TurnHooks {
    const current = () => record.generation === generation;
    return {
      onToolActivity: (activity) => {
        if (!current()) return;
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
      },
      onTurnEnd: (reportedCount) => {
        if (!current()) return;
        const turnCount =
          turnCountMode === "absolute" ? reportedCount : (this.turnCounts.get(record) ?? 0) + 1;
        this.turnCounts.set(record, turnCount);
        options.onTurnEnd?.(turnCount);
      },
      onTextDelta: (delta, fullText) => {
        if (current()) options.onTextDelta?.(delta, fullText);
      },
      onAssistantUsage: (usage) => {
        if (!current()) return;
        recordAssistantUsage(record, usage, options.model);
        options.onAssistantUsage?.(usage);
      },
      onCompaction: (info) => {
        if (!current()) return;
        record.compactionCount++;
        this.onCompact?.(record, info);
        options.onCompaction?.(info);
      },
      onDiagnostic: (event, details) => {
        if (current()) this.recordDiagnostic(record, event, details);
      },
      onAssistantFailure: (failure) => {
        if (current()) this.recordFailure(record, failure);
      },
    };
  }

  private async applyPendingRedirects(
    record: AgentRecord,
    generation: number,
    session: AgentSession,
    abortController: AbortController,
    hooks: TurnHooks,
    responseText: string,
  ): Promise<string> {
    while (
      record.generation === generation &&
      record.pendingCancelSteers?.length &&
      record.status !== "stopped"
    ) {
      const redirect = record.pendingCancelSteers.shift();
      if (!record.pendingCancelSteers.length) record.pendingCancelSteers = undefined;
      if (!redirect) continue;
      await redirect.settled;
      if (!redirect.accepted) continue;
      if (record.generation !== generation || record.status !== "running") break;
      record.status = "running";
      responseText = await resumeAgent(session, redirect.message, {
        signal: abortController.signal,
        ...hooks,
      });
    }
    return responseText;
  }

  private finishGeneration(
    record: AgentRecord,
    generation: number,
    responseText: string,
    session: AgentSession,
  ): void {
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
    getAgentSessionId(record);
    record.completedAt ??= Date.now();
    this.settleGeneration(record, generation);
  }

  private failGeneration(
    record: AgentRecord,
    generation: number,
    abortController: AbortController,
    error: unknown,
  ): void {
    const message = error instanceof Error ? error.message : String(error);
    if (record.status !== "stopped") {
      record.status = "error";
      record.error = message;
    } else if (record.abort?.source !== "interrupt") {
      record.error = message;
    }
    this.recordFailure(record, {
      timestamp: Date.now(),
      phase: "manager",
      message,
      ...(error instanceof Error ? { name: error.name } : {}),
      error_details: serializeDiagnosticError(error),
      manager_signal_aborted: abortController.signal.aborted,
    });
    record.completedAt ??= Date.now();
    this.settleGeneration(record, generation);
  }

  private settleGeneration(record: AgentRecord, generation: number): void {
    this.settledGeneration.set(record, generation);
    this.runtimes.touch(record.id);
    this.recordDiagnostic(record, "completed", {
      status: record.status,
      error: record.error,
      duration_ms: (record.completedAt ?? Date.now()) - record.startedAt,
      tool_uses: record.toolUses,
      lifetime_usage: { ...record.lifetimeUsage },
      compaction_count: record.compactionCount,
      failure_count: record.failureHistory.length,
      abort: record.abort,
    });
    if (record.taskName) this.releaseReservation(record);
    this.notifyComplete(record, generation);
  }

  private manageGeneration(
    record: AgentRecord,
    generation: number,
    abortController: AbortController,
    started: Promise<{ responseText: string; session: AgentSession }>,
    resumeHooks: TurnHooks,
  ): void {
    const promise = started
      .then(async ({ responseText, session }) => {
        if (record.generation !== generation) return responseText;
        responseText = await this.applyPendingRedirects(
          record,
          generation,
          session,
          abortController,
          resumeHooks,
          responseText,
        );
        // Pi may have settled just before input arrived, while manager status is still running.
        // Keep ownership here rather than letting sendCustomMessage launch an untracked turn.
        while (
          record.generation === generation &&
          record.status === "running" &&
          !this.isClosing(record.id) &&
          this.followupPending.get(record)?.()
        ) {
          responseText = await resumeAgent(session, "Continue with the queued follow-up task.", {
            taskContinuation: true,
            signal: abortController.signal,
            ...resumeHooks,
          });
        }
        if (record.generation === generation)
          this.finishGeneration(record, generation, responseText, session);
        return responseText;
      })
      .catch((error) => {
        if (record.generation === generation)
          this.failGeneration(record, generation, abortController, error);
        return "";
      });

    record.promise = promise;
    this.pendingAgents.add(promise);
    void promise.then(
      () => this.pendingAgents.delete(promise),
      () => this.pendingAgents.delete(promise),
    );
  }

  /** Actually start an agent (called immediately or from queue drain). */
  private startAgent(
    id: string,
    record: AgentRecord,
    { pi, parent, parentEntries, type, prompt, options }: SpawnArgs,
  ) {
    const generation = record.generation;
    // Re-validate a caller-supplied cwd: queued spawns can start minutes after
    // spawn()'s check, and the directory may be gone by then (TOCTOU). Same
    // curated errors; drainQueue parks a throw on the record as an error.
    assertValidSpawnCwd(options.cwd);
    const customCwd = options.cwd ?? undefined; // null (RPC "unset") → undefined

    if (!this.reserve(record)) throw new Error("No concurrency slot is available.");
    record.status = "running";
    const queuedAt = record.startedAt;
    record.startedAt = Date.now();
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
    const initialHooks = this.createTurnHooks(record, options, generation, "absolute");
    const resumeHooks = this.createTurnHooks(record, options, generation, "increment");
    const started = runAgent(parent, type, prompt, {
      pi,
      registerCollaboration: this.registerCollaboration?.(record),
      agentId: id,
      agentSessionId: record.incarnation,
      model: options.model,
      isolated: options.isolated,
      thinkingLevel: options.thinkingLevel,
      parentEntries,
      allowedTools: options.allowedTools,
      autoCompactionThreshold: this.getAutoCompactionThreshold?.(),
      cwd: customCwd,
      configCwd: customCwd !== undefined ? parent.cwd : undefined,
      signal: abortController.signal,
      ...initialHooks,
      onSessionCreated: (session) => {
        record.session = session;
        getAgentSessionId(record);
        if (abortController.signal.aborted) {
          void this.runtimes.teardown(session);
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
    });
    this.manageGeneration(record, generation, abortController, started, resumeHooks);
    this.notifyStart(record);
  }

  /** Start queued agents up to the concurrency limit. */
  private drainQueue() {
    if (this.closing) return;
    while (this.queue.length > 0 && this.reservedCount < this.maxConcurrent) {
      const next = this.queue.shift();
      if (!next) break;
      const record = this.agents.get(next.id);
      if (
        !record ||
        this.closer.isClosing(next.id) ||
        record.status !== "queued" ||
        record.generation !== next.generation
      )
        continue;
      try {
        next.start();
      } catch (err) {
        // Surface late failures on the record so the user/agent can see them
        // via /agents, then keep draining.
        record.status = "error";
        record.error = err instanceof Error ? err.message : String(err);
        record.completedAt = Date.now();
        this.settledGeneration.set(record, record.generation);
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
        this.releaseReservation(record);
      }
    }
  }

  /** Queue user input at Pi's next tool-batch boundary, buffering until initialization. */
  steer(id: string, message: string): boolean {
    const record = this.agents.get(id);
    if (
      !record ||
      this.closer.isClosing(id) ||
      (record.status !== "running" && record.status !== "queued" && record.status !== "idle")
    )
      return false;
    if (record.status === "idle") return this.startTurn(id, message);
    if (record.session && record.status === "running") {
      record.session.steer(message).catch(() => {});
    } else {
      if (!record.pendingSteers) record.pendingSteers = [];
      record.pendingSteers.push(message);
    }
    return true;
  }

  async cancelAndSteer(id: string, message: string, signal?: AbortSignal): Promise<boolean> {
    const record = this.agents.get(id);
    if (!record?.session || this.closer.isClosing(id) || record.status !== "running") return false;
    const source = "cancel_and_steer";
    return this.interruptions.interrupt(record, record.session, source, message, signal);
  }

  /** Submit ordinary input through the manager's close-aware lifecycle gate. */
  async sendInput(id: string, message: string, signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted();
    const record = this.agents.get(id);
    if (!record || this.closer.isClosing(id)) return false;
    // A settled open conversation can accept another turn after success, error, or interruption.
    if (record.status !== "running" && record.status !== "queued")
      return this.startTurn(id, message);
    if (record.session && record.status === "running") {
      await steerAgent(record.session, message);
      return true;
    }
    return this.steer(id, message);
  }

  /** Commit native input and turn ownership together, with no await/admission race. */
  followup(id: string, deliver: () => boolean, pending: () => boolean): boolean {
    const record = this.agents.get(id);
    if (!record?.session || this.isClosing(id) || this.isRuntimeDisposing(id)) return false;
    if (record.status !== "running" && record.status !== "queued") {
      if (
        (this.settledGeneration.get(record) ?? 0) < record.generation ||
        !this.options.has(record)
      )
        return false;
      if (this.reservedCount >= this.maxConcurrent)
        throw new Error("No concurrency slot is available.");
    }
    if (!deliver()) return false;
    this.followupPending.set(record, pending);
    if (record.status !== "running" && record.status !== "queued")
      return this.startTurn(id, "Continue with the queued follow-up task.", true);
    return true;
  }

  /** Start another turn on a retained, settled session. */
  startTurn(id: string, prompt: string, taskContinuation = false): boolean {
    if (this.closing) return false;
    const record = this.agents.get(id);
    if (
      !record?.session ||
      this.closer.isClosing(id) ||
      this.isRuntimeDisposing(id) ||
      record.status === "running" ||
      record.status === "queued" ||
      (record.status !== "idle" && (this.settledGeneration.get(record) ?? 0) < record.generation)
    ) {
      return false;
    }

    const options = this.options.get(record);
    if (!options) return false;
    if (
      record.taskName &&
      !this.reservations.has(record) &&
      this.reservedCount >= this.maxConcurrent
    )
      throw new Error("No concurrency slot is available.");
    this.runtimes.touch(id);
    const session = record.session;

    if (record.status !== "idle") record.generation++;
    const generation = record.generation;
    record.prompt = prompt;
    record.status = "queued";
    record.result = undefined;
    record.error = undefined;
    record.abort = undefined;
    record.pendingCancelSteers = undefined;
    record.pendingSteers = undefined;
    record.completedAt = undefined;
    record.startedAt = Date.now();
    const abortController = new AbortController();
    record.abortController = abortController;
    const start = () =>
      this.startRetainedTurn(
        record,
        session,
        prompt,
        options,
        abortController,
        generation,
        taskContinuation,
      );
    if (!this.reservations.has(record) && this.reservedCount >= this.maxConcurrent) {
      this.queue.push({ id, generation, start });
    } else {
      start();
    }
    return true;
  }

  private startRetainedTurn(
    record: AgentRecord,
    session: AgentSession,
    prompt: string,
    options: SpawnOptions,
    abortController: AbortController,
    generation: number,
    taskContinuation: boolean,
  ): void {
    if (record.generation !== generation || record.status !== "queued") return;
    if (!this.reserve(record)) return;
    record.status = "running";
    const queuedAt = record.startedAt;
    record.startedAt = Date.now();
    try {
      this.recordDiagnostic(record, "started", {
        resumed: true,
        generation,
        queue_duration_ms: record.startedAt - queuedAt,
        manager_running_count: this.runningCount,
        manager_queue_length: this.queue.length,
        manager_max_concurrent: this.maxConcurrent,
      });
      const hooks = this.createTurnHooks(record, options, generation, "increment");
      if (!record.taskName) this.clearSessionQueue(session);
      if (record.pendingSteers?.length) {
        for (const message of record.pendingSteers) session.steer(message).catch(() => {});
        record.pendingSteers = undefined;
      }
      const started = resumeAgent(session, prompt, {
        taskContinuation,
        signal: abortController.signal,
        ...hooks,
      }).then((responseText) => ({ responseText, session }));
      this.manageGeneration(record, generation, abortController, started, hooks);
      this.notifyStart(record);
    } catch (error) {
      this.failGeneration(record, generation, abortController, error);
    }
  }

  /** Abort the active turn after session creation without disposing the retained session. */
  async interruptTurn(id: string): Promise<boolean> {
    const record = this.agents.get(id);
    if (
      !record?.session ||
      this.closer.isClosing(id) ||
      record.status !== "running" ||
      !record.promise
    )
      return false;

    const session = record.session;
    const promise = record.promise;
    const interrupted = await this.interruptions.interrupt(record, session, "interrupt");
    if (!interrupted) return false;
    await promise;
    return true;
  }

  sendParent(record: AgentRecord, message: string): boolean {
    return (
      this.messageParent?.(
        record.parentSessionId,
        {
          id: record.id,
          type: record.type,
          title: record.description,
          ...(record.invocation?.modelName ? { model_name: record.invocation.modelName } : {}),
          ...(record.invocation?.thinking ? { thinking: record.invocation.thinking } : {}),
        },
        message,
      ) ?? false
    );
  }

  isClosing(id: string): boolean {
    return this.closer.isClosing(id) || this.closing;
  }

  getRecord(id: string): AgentRecord | undefined {
    return this.agents.get(id);
  }

  listAgents(): AgentRecord[] {
    return [...this.agents.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  getClosedRecord(id: string): ClosedAgentRecord | undefined {
    return this.closer.get(id);
  }

  reopen(pi: ExtensionAPI, ctx: SubagentContext, id: string, options?: ReopenOptions) {
    this.tree.assertCanDelegate(ctx.sessionManager.getSessionId());
    return this.reopener.open(pi, ctx, id, {
      ...options,
      rootSessionId: this.tree.rootSessionId(ctx.sessionManager.getSessionId()),
    });
  }

  async reload(pi: ExtensionAPI, ctx: SubagentContext, id: string, signal?: AbortSignal) {
    await this.runtimes.pending(id);
    signal?.throwIfAborted();
    if (this.isClosing(id)) throw new Error("Subagent owner is closed");
    return this.reopener.open(pi, ctx, id, {
      signal,
      scopeModels: ctx.scopeModels,
      rootSessionId: this.tree.rootSessionId(ctx.sessionManager.getSessionId()),
    });
  }

  isRuntimeReopening(id: string): boolean {
    return !!this.reopener.pending(id);
  }

  isRuntimeDisposing(id: string): boolean {
    return this.runtimes.isDisposing(id);
  }

  disposeRuntime(id: string): Promise<void> {
    return this.runtimes.dispose(id);
  }

  /** Close a retained agent and every descendant represented by this manager. */
  close(id: string) {
    const pending = this.reopener.pending(id);
    if (pending && this.agents.get(id)?.taskName) this.reopener.cancel(id);
    if (pending) return pending.catch(() => undefined).then(() => this.closer.close(id));
    return this.closer.close(id);
  }

  abort(id: string): boolean {
    const record = this.agents.get(id);
    if (!record) return false;

    // Remove from queue if queued
    if (record.status === "queued" || record.status === "idle") {
      this.queue = this.queue.filter((q) => q.id !== id);
      record.pendingSteers = undefined;
      record.status = "stopped";
      record.completedAt = Date.now();
      this.settledGeneration.set(record, record.generation);
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
    record.pendingCancelSteers = undefined;
    record.status = "stopped";
    record.error = "aborted";
    record.completedAt = Date.now();
    record.abort = { timestamp: Date.now(), source: "stop", reason: "stop" };
    try {
      this.recordDiagnostic(record, "abort_requested", { source: "stop" });
      this.clearSessionQueue(record.session);
    } finally {
      record.abortController?.abort(record.abort.reason);
    }
    return true;
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
        record.pendingSteers = undefined;
        record.pendingCancelSteers = undefined;
        record.status = "stopped";
        record.completedAt = Date.now();
        this.settledGeneration.set(record, record.generation);
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
        record.pendingSteers = undefined;
        record.pendingCancelSteers = undefined;
        record.abort = { timestamp: Date.now(), source: "shutdown", reason: "shutdown" };
        this.recordDiagnostic(record, "abort_requested", { source: "shutdown" });
        this.clearSessionQueue(record.session);
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
    // Loop because an available slot can start queued work that also needs awaiting.
    for (;;) {
      this.drainQueue();
      if (this.pendingAgents.size === 0) break;
      await Promise.allSettled(this.pendingAgents);
    }
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.closing = true;
    void this.reopener.shutdown();
    this.shutdownPromise = Promise.resolve().then(() => this.finishShutdown());
    return this.shutdownPromise;
  }

  private async finishShutdown(): Promise<void> {
    this.abortAll();
    await this.reopener.shutdown();
    await this.waitForAll();
    await this.runtimes.waitForAll();
    for (const record of this.agents.values()) {
      if (record.session) void this.runtimes.teardown(record.session);
      this.releaseReservation(record);
    }
    await this.runtimes.waitForAll();
    this.agents.clear();
    this.closer.clear();
  }

  dispose(): Promise<void> {
    return this.shutdown();
  }
}
