import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildEventData } from "./event-data.js";
import { buildNotificationDetails, formatTaskNotification } from "./notifications.js";
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
  return {
    id: record.id,
    type: record.type,
    description: record.description,
    status: record.status,
    ...(includeOutput && record.result !== undefined ? { result: record.result } : {}),
    ...(includeOutput && record.error !== undefined ? { error: record.error } : {}),
    tool_uses: record.toolUses,
    duration_ms: (record.completedAt ?? Date.now()) - record.startedAt,
    total_tokens: getLifetimeTotal(record.lifetimeUsage),
    lifetime_usage: { ...record.lifetimeUsage },
  };
}

type AgentCompletionDeps = {
  pi: ExtensionAPI;
  getRecord: (id: string) => AgentRecord | undefined;
  onAgentFinishedUI: (id: string) => void;
  scheduleAutomatic?: (parentSessionId: string, deliver: () => void) => boolean;
};

type Waiter = {
  id: number;
  agentIds: string[];
  resolve: (outcome: WaitAgentOutcome) => void;
  timer?: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
};

export function createAgentCompletionHandler({
  pi,
  getRecord,
  onAgentFinishedUI,
  scheduleAutomatic,
}: AgentCompletionDeps) {
  const owners = new WeakMap<AgentRecord, "automatic" | "wait">();
  const completed = new WeakSet<AgentRecord>();
  const claims = new Map<string, number>();
  const waiters = new Map<number, Waiter>();
  let nextWaiterId = 1;
  let disposed = false;

  function release(waiter: Waiter): void {
    waiters.delete(waiter.id);
    for (const id of waiter.agentIds) {
      if (claims.get(id) === waiter.id) claims.delete(id);
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
    for (const record of terminal) owners.set(record, "wait");
    const terminalIds = new Set(terminal.map((record) => record.id));
    return {
      outcome: "terminal",
      timed_out: false,
      agents: records.map((record) => buildWaitAgentResult(record, terminalIds.has(record.id))),
    };
  }

  function resolveWaiter(waiterId: number): void {
    const waiter = waiters.get(waiterId);
    if (!waiter) return;
    const records = waiter.agentIds
      .map(getRecord)
      .filter((record): record is AgentRecord => Boolean(record));
    const terminal = records
      .filter(isTerminal)
      .filter((record) => owners.get(record) !== "automatic");
    if (terminal.length > 0) finish(waiter, terminalOutcome(records, terminal));
  }

  function onAgentMessage(sender: WaitAgentSender, message: string): boolean {
    const waiterId = claims.get(sender.id);
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

  function onAgentComplete(record: AgentRecord): void {
    if (disposed || completed.has(record)) return;
    completed.add(record);
    const failed = record.status === "error" || record.status === "stopped";
    pi.events.emit(failed ? "subagents:failed" : "subagents:completed", buildEventData(record));
    onAgentFinishedUI(record.id);

    const waiterId = claims.get(record.id);
    if (waiterId !== undefined) {
      resolveWaiter(waiterId);
    } else {
      try {
        const accepted = scheduleAutomatic
          ? scheduleAutomatic(record.parentSessionId, () => {
              try {
                emitAutomatic(record);
              } catch (error) {
                owners.delete(record);
                throw error;
              }
            })
          : (emitAutomatic(record), true);
        if (accepted) owners.set(record, "automatic");
      } catch {
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

    const claimed = uniqueIds.filter((id) => claims.has(id));
    if (claimed.length > 0) {
      return Promise.resolve({
        outcome: "error",
        timed_out: false,
        message: `Agent already has an active waiter: ${claimed.join(", ")}`,
        agents: (records as AgentRecord[]).map((record) => buildWaitAgentResult(record, false)),
      });
    }

    const delivered = (records as AgentRecord[])
      .filter((record) => owners.has(record))
      .map((record) => record.id);
    if (delivered.length > 0) {
      return Promise.resolve({
        outcome: "error",
        timed_out: false,
        message: `Agent result already delivered: ${delivered.join(", ")}`,
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
        resolve,
        signal,
      };
      for (const id of uniqueIds) claims.set(id, waiter.id);
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
