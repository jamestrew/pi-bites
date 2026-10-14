import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { waitForOperation } from "../shared/abortable-wait.js";
import type { AgentManager } from "./agent-manager.js";
import { getAgentSessionId } from "./agent-tree.js";
import { allowedSubagentModels, assertAgentModel } from "./model-scope.js";
import type { AgentRecord } from "./types.js";
import type { SubagentContext } from "./operation-context.js";
import type { createSubagentMessenger, SubagentMessageDetails } from "./subagent-messages.js";

export interface TaskDelivery {
  getMessenger: (sessionId: string) => ReturnType<typeof createSubagentMessenger> | undefined;
  queueMail: (sessionId: string, details: SubagentMessageDetails) => boolean;
}

/** Manager-owned retained delivery, including native follow-up acceptance. */
export class AgentDelivery {
  private pending = new WeakMap<AgentRecord, () => boolean>();

  constructor(
    private manager: AgentManager,
    private isReady: (record: AgentRecord) => boolean,
  ) {}

  hasPending(record: AgentRecord): boolean {
    return this.pending.get(record)?.() ?? false;
  }

  async deliver(
    pi: ExtensionAPI,
    ctx: SubagentContext,
    id: string,
    details: SubagentMessageDetails,
    delivery: TaskDelivery,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const manager = this.manager;
    signal?.throwIfAborted();
    const record = manager.getRecord(id);
    if (!record) return false;
    // Snapshot the fallback while ctx is active; deferred checks use owned root policy.
    const allowed = allowedSubagentModels(ctx);
    const getAllowedModels = manager.getAllowedModels ?? ctx.getAllowedModels ?? (() => allowed);
    if (details.task) assertAgentModel(record, getAllowedModels());
    const release = manager.runtimes.protect(id);
    try {
      // Out-of-scope conversations still receive mail, without an unauthorized reload.
      const mayReload =
        details.task ||
        !record.invocation?.modelName ||
        getAllowedModels().some(
          (model) => `${model.provider}/${model.id}` === record.invocation?.modelName,
        );
      if (mayReload && (!record.session || manager.isRuntimeDisposing(id))) {
        await manager.reload(pi, ctx, id, signal);
        signal?.throwIfAborted();
      }
      if (manager.isClosing(id)) throw new Error("Target agent is closing");
      const sessionId = getAgentSessionId(record);
      if (!sessionId) return false;
      const messenger = delivery.getMessenger(sessionId);
      const deliver = () => delivery.queueMail(sessionId, details);
      // Interrupt submission precedes tool unwinding; do not commit new work until it settles.
      if (details.task && record.status === "stopped" && record.abort?.source === "interrupt") {
        if (record.promise)
          await (signal ? waitForOperation(record.promise, signal) : record.promise);
        signal?.throwIfAborted();
      }
      if (!details.task) return deliver();
      if (!record.session || manager.isClosing(id) || manager.isRuntimeDisposing(id)) return false;
      assertAgentModel(record, getAllowedModels());
      const idle = record.status !== "running" && record.status !== "queued";
      if (idle) {
        if (!this.isReady(record)) return false;
        manager.assertExecutionAvailable();
      }
      // Native acceptance is the commit point. Start without another capacity check.
      if (!deliver()) return false;
      this.pending.set(record, () => (messenger?.observe().pendingTasks ?? 0) > 0);
      return record.status !== "running" && record.status !== "queued"
        ? manager.startTurn(id, "Continue with the queued follow-up task.", true, true)
        : true;
    } finally {
      release();
    }
  }
}
