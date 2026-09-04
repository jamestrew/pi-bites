import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildEventData } from "./event-data.js";
import { buildNotificationDetails, formatTaskNotification } from "./notifications.js";
import { isMissingFinalResponse, MISSING_FINAL_RESPONSE_ERROR } from "./types.js";
import type {
  AgentRecord,
  NotificationDetails,
  WaitAgentOutcome,
  WaitAgentResult,
  WaitAgentSender,
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
  const owners = new WeakMap<AgentRecord, Map<number, "automatic" | "wait">>();
  const completedGeneration = new WeakMap<AgentRecord, number>();
  const claims = new Map<string, number>();
  const waiters = new Map<number, Waiter>();
  let nextWaiterId = 1;
  let disposed = false;

  const claimKey = (id: string, generation: number) => `${id}:${generation}`;
  const getOwner = (record: AgentRecord, generation = record.generation) =>
    owners.get(record)?.get(generation);
  const setOwner = (record: AgentRecord, generation: number, owner: "automatic" | "wait") => {
    let generations = owners.get(record);
    if (!generations) owners.set(record, (generations = new Map<number, "automatic" | "wait">()));
    generations.set(generation, owner);
  };
  const deleteOwner = (record: AgentRecord, generation: number) => {
    owners.get(record)?.delete(generation);
  };

  function release(waiter: Waiter): void {
    waiters.delete(waiter.id);
    for (const id of waiter.agentIds) {
      const key = claimKey(id, waiter.generations.get(id) ?? 0);
      if (claims.get(key) === waiter.id) claims.delete(key);
    }
    if (waiter.timer) clearTimeout(waiter.timer);
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
    }
  }

  function finish(waiter: Waiter, outcome: WaitAgentOutcome): void {
    release(waiter);
    waiter.resolve(outcome);
  }

  function terminalOutcome(
    records: AgentRecord[],
    terminal = records.filter(isTerminal),
  ): WaitAgentOutcome {
    for (const record of terminal) {
      const canonical = getRecord(record.id);
      if (canonical?.generation === record.generation)
        setOwner(canonical, record.generation, "wait");
    }
    const terminalIds = new Set(terminal.map((record) => record.id));
    return {
      outcome: "terminal",
      timed_out: false,
      agents: records.map((record) => buildWaitAgentResult(record, terminalIds.has(record.id))),
    };
  }

  function resolveWaiter(waiterId: number, completedRecord?: AgentRecord): void {
    const waiter = waiters.get(waiterId);
    if (!waiter) return;
    const records = waiter.agentIds
      .map((id) => (id === completedRecord?.id ? completedRecord : getRecord(id)))
      .filter((record): record is AgentRecord => Boolean(record));
    const terminal = records
      .filter(
        (record) => record.generation === waiter.generations.get(record.id) && isTerminal(record),
      )
      .filter((record) => getOwner(record) !== "automatic");
    if (terminal.length > 0) finish(waiter, terminalOutcome(records, terminal));
  }

  function onAgentMessage(sender: WaitAgentSender, message: string): boolean {
    const record = getRecord(sender.id);
    if (!record) return false;
    const waiterId = claims.get(claimKey(sender.id, record.generation));
    if (waiterId === undefined) return false;
    const waiter = waiters.get(waiterId);
    if (!waiter) return false;

    finish(waiter, {
      outcome: "message",
      timed_out: false,
      sender,
      message,
      agents: waiter.agentIds
        .map(getRecord)
        .filter((record): record is AgentRecord => Boolean(record))
        .map((record) => buildWaitAgentResult(record, false)),
    });
    return true;
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
      /* event listeners must not change completion delivery ownership */
    }
  }

  function onAgentComplete(record: AgentRecord, generation = record.generation): void {
    if (disposed || (completedGeneration.get(record) ?? 0) >= generation) return;
    completedGeneration.set(record, generation);
    for (const previous of owners.get(record)?.keys() ?? []) {
      if (previous < generation) deleteOwner(record, previous);
    }
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
        /* UI cleanup must not change completion delivery ownership */
      }
    };

    const waiterId = claims.get(claimKey(record.id, generation));
    const existingOwner = getOwner(record, generation);
    if (waiterId !== undefined) {
      notifyFinishedUI();
      resolveWaiter(waiterId, finished);
      emitCompletionEvent(finished, failed);
    } else if (existingOwner === "wait") {
      notifyFinishedUI();
      emitCompletionEvent(finished, failed);
    } else {
      setOwner(record, generation, "automatic");
      emitCompletionEvent(finished, failed);
      let finishedUI = false;
      const finishUI = () => {
        if (finishedUI) return;
        finishedUI = true;
        notifyFinishedUI();
      };
      const cancelAutomatic = () => {
        deleteOwner(record, generation);
        finishUI();
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
                } catch (error) {
                  deleteOwner(record, generation);
                  throw error;
                } finally {
                  finishUI();
                }
              },
              cancelAutomatic,
            )
          : (emitAutomatic(finished), finishUI(), true);
        if (!accepted) {
          deleteOwner(record, generation);
          finishUI();
        }
      } catch {
        deleteOwner(record, generation);
        finishUI();
        /* automatic delivery failure leaves the completed result available to WaitAgent */
      }
    }
  }

  function waitFor(
    agentIds: string[],
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<WaitAgentOutcome> {
    const uniqueIds = [...new Set(agentIds)];
    if (uniqueIds.length !== agentIds.length) {
      return Promise.resolve({
        outcome: "error",
        timed_out: false,
        message: "agent_ids must not contain duplicates",
        agents: [],
      });
    }

    const records = uniqueIds.map(getRecord);
    const missing = uniqueIds.filter((_id, index) => !records[index]);
    if (missing.length > 0) {
      return Promise.resolve({
        outcome: "error",
        timed_out: false,
        message: `Agent not found: ${missing.join(", ")}`,
        agents: records
          .filter((record): record is AgentRecord => Boolean(record))
          .map((record) => buildWaitAgentResult(record, false)),
      });
    }

    const generations = new Map(
      (records as AgentRecord[]).map((record) => [record.id, record.generation]),
    );
    const claimed = uniqueIds.filter((id) => claims.has(claimKey(id, generations.get(id) ?? 0)));
    if (claimed.length > 0) {
      return Promise.resolve({
        outcome: "error",
        timed_out: false,
        message: `Agent already has an active waiter: ${claimed.join(", ")}`,
        agents: (records as AgentRecord[]).map((record) => buildWaitAgentResult(record, false)),
      });
    }

    const deliveryClaimed = (records as AgentRecord[])
      .filter((record) => getOwner(record) !== undefined)
      .map((record) => record.id);
    if (deliveryClaimed.length > 0) {
      return Promise.resolve({
        outcome: "delivery_claimed",
        timed_out: false,
        agents: (records as AgentRecord[]).map((record) => buildWaitAgentResult(record, false)),
      });
    }

    const terminal = (records as AgentRecord[]).filter(isTerminal);
    if (terminal.length > 0)
      return Promise.resolve(terminalOutcome(records as AgentRecord[], terminal));

    if (signal?.aborted) {
      return Promise.resolve({
        outcome: "cancelled",
        timed_out: false,
        agents: (records as AgentRecord[]).map((record) => buildWaitAgentResult(record, false)),
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
      for (const id of uniqueIds) {
        claims.set(claimKey(id, generations.get(id) ?? 0), waiter.id);
      }
      waiters.set(waiter.id, waiter);
      waiter.timer = setTimeout(() => {
        finish(waiter, {
          outcome: "timeout",
          timed_out: true,
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
    onAgentMessage,
    onAgentComplete,
    dispose(): void {
      disposed = true;
      for (const waiter of waiters.values()) {
        finish(waiter, {
          outcome: "cancelled",
          timed_out: false,
          agents: waiter.agentIds
            .map(getRecord)
            .filter((record): record is AgentRecord => Boolean(record))
            .map((record) => buildWaitAgentResult(record, false)),
        });
      }
      claims.clear();
    },
  };
}
