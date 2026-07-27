import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildEventData } from "./event-data.js";
import { GroupJoinManager } from "./group-join.js";
import { buildNotificationDetails, formatTaskNotification } from "./notifications.js";
import type { AgentRecord, JoinMode, NotificationDetails } from "./types.js";

type AgentCompletionDeps = {
  pi: ExtensionAPI;
  getRecord: (id: string) => AgentRecord | undefined;
  onAgentFinishedUI: (id: string) => void;
};

export function createAgentCompletionHandler({
  pi,
  getRecord,
  onAgentFinishedUI,
}: AgentCompletionDeps) {
  const pendingNudges = new Map<string, ReturnType<typeof setTimeout>>();
  const NUDGE_HOLD_MS = 200;
  let currentBatchAgents: string[] = [];
  let batchFinalizeTimer: ReturnType<typeof setTimeout> | undefined;
  let batchCounter = 0;

  function cancelNudge(key: string): void {
    const timer = pendingNudges.get(key);
    if (timer === undefined) return;
    clearTimeout(timer);
    pendingNudges.delete(key);
  }

  function scheduleNudge(key: string, send: () => void, delay = NUDGE_HOLD_MS): void {
    cancelNudge(key);
    pendingNudges.set(
      key,
      setTimeout(() => {
        pendingNudges.delete(key);
        try {
          send();
        } catch {
          // The extension context may have gone stale while this notification was held.
        }
      }, delay),
    );
  }

  function emitIndividualNudge(record: AgentRecord): void {
    pi.sendMessage<NotificationDetails>(
      {
        customType: "subagent-notification",
        content: formatTaskNotification(record),
        display: true,
        details: buildNotificationDetails(record, 500, undefined),
      },
      { deliverAs: "followUp", triggerTurn: true },
    );
  }

  function sendIndividualNudge(record: AgentRecord): void {
    onAgentFinishedUI(record.id);
    scheduleNudge(record.id, () => emitIndividualNudge(record));
  }

  const groupJoin = new GroupJoinManager((records, partial) => {
    for (const record of records) onAgentFinishedUI(record.id);

    const groupKey = `group:${records.map((record) => record.id).join(",")}`;
    scheduleNudge(groupKey, () => {
      const notifications = records.map(formatTaskNotification).join("\n\n");
      const label = partial
        ? `${records.length} agent(s) finished (partial — others still running)`
        : `${records.length} agent(s) finished`;
      const [first, ...rest] = records;
      if (!first) return;
      const details = buildNotificationDetails(first, 300, undefined);
      if (rest.length > 0) {
        details.others = rest.map((record) => buildNotificationDetails(record, 300, undefined));
      }

      pi.sendMessage<NotificationDetails>(
        {
          customType: "subagent-notification",
          content: `Background agent group completed: ${label}\n\n${notifications}`,
          display: true,
          details,
        },
        { deliverAs: "followUp", triggerTurn: true },
      );
    });
  }, 30_000);

  function finalizeBatch(): void {
    batchFinalizeTimer = undefined;
    const batchAgents = [...currentBatchAgents];
    currentBatchAgents = [];

    if (batchAgents.length >= 2) {
      const groupId = `batch-${++batchCounter}`;
      groupJoin.registerGroup(groupId, batchAgents);
      for (const id of batchAgents) {
        const record = getRecord(id);
        if (!record) continue;
        record.groupId = groupId;
        if (record.completedAt != null) groupJoin.onAgentComplete(record);
      }
      return;
    }

    for (const id of batchAgents) {
      const record = getRecord(id);
      if (record?.completedAt != null) sendIndividualNudge(record);
    }
  }

  function trackSpawned(id: string, joinMode: JoinMode): void {
    if (joinMode === "async") return;
    currentBatchAgents.push(id);
    if (batchFinalizeTimer) clearTimeout(batchFinalizeTimer);
    batchFinalizeTimer = setTimeout(finalizeBatch, 100);
  }

  function onAgentComplete(record: AgentRecord): void {
    const failed = record.status === "error" || record.status === "stopped";
    pi.events.emit(failed ? "subagents:failed" : "subagents:completed", buildEventData(record));
    pi.appendEntry("subagents:record", {
      id: record.id,
      type: record.type,
      description: record.description,
      status: record.status,
      result: record.result,
      error: record.error,
      startedAt: record.startedAt,
      completedAt: record.completedAt,
    });

    if (record.isBackground === false) {
      onAgentFinishedUI(record.id);
      return;
    }

    if (currentBatchAgents.includes(record.id)) return;

    if (groupJoin.onAgentComplete(record) === "pass") sendIndividualNudge(record);
  }

  return {
    trackSpawned,
    onAgentComplete,
    dispose(): void {
      if (batchFinalizeTimer) clearTimeout(batchFinalizeTimer);
      batchFinalizeTimer = undefined;
      currentBatchAgents = [];
      for (const timer of pendingNudges.values()) clearTimeout(timer);
      pendingNudges.clear();
      groupJoin.dispose();
    },
  };
}
