import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildEventData } from "./event-data.js";
import { buildNotificationDetails, formatTaskNotification } from "./notifications.js";
import { isMissingFinalResponse, MISSING_FINAL_RESPONSE_ERROR } from "./types.js";
import type {
  AgentRecord,
  NotificationDetails,
  WaitAgentOutcome,
  WaitAgentResult,
  WaitAgentStatus,
} from "./types.js";
import { getLifetimeTotal } from "./usage.js";

const TERMINAL_STATUSES = new Set(["completed", "error", "stopped"]);

function isTerminal(record: AgentRecord): boolean {
  return TERMINAL_STATUSES.has(record.status);
}

export function buildWaitAgentResult(record: AgentRecord, includeOutput: boolean): WaitAgentResult {
  const missingFinal = isMissingFinalResponse(record.status, record.result);
  return {
    id: record.id,
    type: record.type,
    description: record.description,
    status: missingFinal ? "error" : record.status,
    ...(includeOutput && record.result !== undefined && !missingFinal
      ? { result: record.result }
      : {}),
    ...(includeOutput && (missingFinal || record.error !== undefined)
      ? { error: missingFinal ? MISSING_FINAL_RESPONSE_ERROR : record.error }
      : {}),
    tool_uses: record.toolUses,
    duration_ms: (record.completedAt ?? Date.now()) - record.startedAt,
    total_tokens: getLifetimeTotal(record.lifetimeUsage),
    lifetime_usage: { ...record.lifetimeUsage },
    ...(includeOutput && record.failureHistory.length > 0
      ? { failure_history: record.failureHistory.map((failure) => ({ ...failure })) }
      : {}),
    ...(includeOutput && record.abort ? { abort: { ...record.abort } } : {}),
  };
}

function buildWaitAgentStatus(record: AgentRecord): WaitAgentStatus {
  switch (record.status) {
    case "queued":
      return "pending_init";
    case "running":
      return "running";
    case "completed":
      return { completed: record.result?.trim() ? record.result : null };
    case "error":
      return { errored: record.error ?? "unknown error" };
    case "stopped":
      return "shutdown";
  }
}

function buildMissingWaitAgentResult(id: string): WaitAgentResult {
  return {
    id,
    type: "unknown",
    description: id,
    status: "not_found",
    tool_uses: 0,
    duration_ms: 0,
    total_tokens: 0,
    lifetime_usage: { input: 0, output: 0, cacheWrite: 0 },
  };
}

type AgentCompletionDeps = {
  pi: ExtensionAPI;
  getRecord: (id: string) => AgentRecord | undefined;
  onAgentFinishedUI: (id: string) => void;
  onAgentResultPendingUI?: (id: string) => void;
  scheduleAutomatic?: (parentSessionId: string, deliver: () => void, cancel: () => void) => boolean;
};

type Waiter = {
  id: number;
  agentIds: string[];
  generations: Map<string, number>;
  resolve: (outcome: WaitAgentOutcome) => void;
  timer?: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
};

export function createAgentCompletionHandler({
  pi,
  getRecord,
  onAgentFinishedUI,
  onAgentResultPendingUI,
  scheduleAutomatic,
}: AgentCompletionDeps) {
  const completedGeneration = new WeakMap<AgentRecord, number>();
  const waiters = new Map<number, Waiter>();
  let nextWaiterId = 1;
  let disposed = false;

  function release(waiter: Waiter): void {
    waiters.delete(waiter.id);
    if (waiter.timer) clearTimeout(waiter.timer);
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
    }
  }

  function finish(waiter: Waiter, outcome: WaitAgentOutcome): void {
    release(waiter);
    waiter.resolve(outcome);
  }

  function terminalOutcome(agentIds: string[], completedRecord?: AgentRecord): WaitAgentOutcome {
    const status: Record<string, WaitAgentStatus> = {};
    const agents = agentIds.map((id) => {
      const record = id === completedRecord?.id ? completedRecord : getRecord(id);
      if (!record) {
        status[id] = "not_found";
        return buildMissingWaitAgentResult(id);
      }
      const terminal = isTerminal(record);
      if (terminal) status[id] = buildWaitAgentStatus(record);
      return buildWaitAgentResult(record, terminal);
    });
    return { outcome: "terminal", timed_out: false, status, agents };
  }

  function resolveWaiters(completedRecord: AgentRecord): void {
    for (const waiter of waiters.values()) {
      if (
        waiter.agentIds.includes(completedRecord.id) &&
        waiter.generations.get(completedRecord.id) === completedRecord.generation
      ) {
        finish(waiter, terminalOutcome(waiter.agentIds, completedRecord));
      }
    }
  }

  function emitAutomatic(record: AgentRecord): void {
    const details = buildNotificationDetails(record);
    pi.sendMessage<NotificationDetails>(
      {
        customType: "subagent-notification",
        content: formatTaskNotification(record),
        display: true,
        details,
      },
      { deliverAs: "steer", triggerTurn: true },
    );
  }

  function emitCompletionEvent(record: AgentRecord, failed: boolean): void {
    try {
      pi.events.emit(failed ? "subagents:failed" : "subagents:completed", buildEventData(record));
    } catch {
      /* event listeners must not change completion delivery */
    }
  }

  function onAgentComplete(record: AgentRecord, generation = record.generation): void {
    if (disposed || (completedGeneration.get(record) ?? 0) >= generation) return;
    completedGeneration.set(record, generation);
    const finished: AgentRecord = {
      ...record,
      generation,
      toolCalls: [...record.toolCalls],
      lifetimeUsage: { ...record.lifetimeUsage },
      failureHistory: record.failureHistory.map((failure) => ({ ...failure })),
      ...(record.abort ? { abort: { ...record.abort } } : {}),
    };
    const failed = finished.status === "error" || finished.status === "stopped";
    const notifyFinishedUI = () => {
      if (getRecord(record.id)?.generation !== generation) return;
      try {
        onAgentFinishedUI(record.id);
      } catch {
        /* UI cleanup must not change completion delivery */
      }
    };

    resolveWaiters(finished);
    emitCompletionEvent(finished, failed);

    let finishedUI = false;
    const finishUI = () => {
      if (finishedUI) return;
      finishedUI = true;
      notifyFinishedUI();
    };
    try {
      if (getRecord(record.id)?.generation === generation) onAgentResultPendingUI?.(record.id);
    } catch {
      /* UI state must not block completion delivery */
    }
    try {
      const accepted = scheduleAutomatic
        ? scheduleAutomatic(
            record.parentSessionId,
            () => {
              try {
                emitAutomatic(finished);
              } finally {
                finishUI();
              }
            },
            finishUI,
          )
        : (emitAutomatic(finished), finishUI(), true);
      if (!accepted) finishUI();
    } catch {
      finishUI();
      /* notification failure must not change explicit wait results */
    }
  }

  function waitFor(
    agentIds: string[],
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<WaitAgentOutcome> {
    const uniqueIds = [...new Set(agentIds)];
    if (uniqueIds.length === 0) {
      return Promise.resolve({
        outcome: "error",
        timed_out: false,
        status: {},
        message: "agent ids must be non-empty",
        agents: [],
      });
    }

    const records = uniqueIds.map(getRecord);
    const generations = new Map(
      records
        .filter((record): record is AgentRecord => Boolean(record))
        .map((record) => [record.id, record.generation]),
    );
    if (records.some((record) => !record || isTerminal(record))) {
      return Promise.resolve(terminalOutcome(uniqueIds));
    }

    const agents = (records as AgentRecord[]).map((record) => buildWaitAgentResult(record, false));
    if (signal?.aborted) {
      return Promise.resolve({
        outcome: "cancelled",
        timed_out: false,
        status: {},
        agents,
      });
    }

    return new Promise((resolve) => {
      const waiter: Waiter = {
        id: nextWaiterId++,
        agentIds: uniqueIds,
        generations,
        resolve,
        signal,
      };
      waiters.set(waiter.id, waiter);
      waiter.timer = setTimeout(() => {
        finish(waiter, {
          outcome: "timeout",
          timed_out: true,
          status: {},
          agents: waiter.agentIds
            .map(getRecord)
            .filter((record): record is AgentRecord => Boolean(record))
            .map((record) => buildWaitAgentResult(record, false)),
        });
      }, timeoutMs);
      if (signal) {
        waiter.onAbort = () => {
          finish(waiter, {
            outcome: "cancelled",
            timed_out: false,
            status: {},
            agents: waiter.agentIds
              .map(getRecord)
              .filter((record): record is AgentRecord => Boolean(record))
              .map((record) => buildWaitAgentResult(record, false)),
          });
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
    });
  }

  return {
    waitFor,
    onAgentComplete,
    dispose(): void {
      disposed = true;
      for (const waiter of waiters.values()) {
        finish(waiter, {
          outcome: "cancelled",
          timed_out: false,
          status: {},
          agents: waiter.agentIds
            .map(getRecord)
            .filter((record): record is AgentRecord => Boolean(record))
            .map((record) => buildWaitAgentResult(record, false)),
        });
      }
    },
  };
}
