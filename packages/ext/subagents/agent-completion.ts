import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildEventData } from "./event-data.js";
import type { AgentRecord } from "./types.js";

/** Completion mail and UI events are separate; neither starts an idle parent turn. */
export function createAgentCompletionHandler({
  pi,
  getRecord,
  onAgentFinishedUI,
  shouldNotify,
  queueCompletion,
}: {
  pi: ExtensionAPI;
  getRecord: (id: string) => AgentRecord | undefined;
  onAgentFinishedUI: (id: string) => void;
  shouldNotify: (record: AgentRecord) => boolean;
  queueCompletion: (record: AgentRecord) => void;
}) {
  const completedGeneration = new WeakMap<AgentRecord, number>();
  let disposed = false;
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
      const current = getRecord(record.id);
      if (current && current.generation !== generation) return;
      try {
        onAgentFinishedUI(record.id);
      } catch {
        /* UI cleanup must not change completion delivery */
      }
    };

    emitCompletionEvent(finished, failed);
    if (finished.status === "stopped" || !shouldNotify(record)) {
      notifyFinishedUI();
      return;
    }

    try {
      queueCompletion(finished);
    } finally {
      notifyFinishedUI();
    }
  }
  return {
    onAgentComplete,
    dispose() {
      disposed = true;
    },
  };
}
