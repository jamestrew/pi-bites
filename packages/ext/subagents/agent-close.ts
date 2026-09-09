import { getAgentStatus } from "./agent-status.js";
import type { AgentRecord, SubagentType, WaitAgentStatus } from "./types.js";

export type ClosedAgentRecord =
  | { id: string; recoverable: false }
  | {
      id: string;
      recoverable: true;
      sessionFile: string;
      type: SubagentType;
      parentSessionId: string;
      description: string;
    };

type CloseHooks = {
  abort: (id: string) => void;
  canRemove: (record: AgentRecord) => boolean;
  hasSlot: (record: AgentRecord) => boolean;
  teardown: (record: AgentRecord) => Promise<void>;
  releaseReservation: (record: AgentRecord) => void;
};

type PreparedClose = {
  record: AgentRecord;
  holdsReservation: boolean;
};

/** Owns subtree claims, teardown, and the minimal tombstones used by resume_agent. */
export class AgentCloser {
  private closed = new Map<string, ClosedAgentRecord>();
  private closing = new Map<string, Promise<void>>();

  constructor(
    private agents: Map<string, AgentRecord>,
    private hooks: CloseHooks,
  ) {}

  get(id: string): ClosedAgentRecord | undefined {
    return this.closed.get(id);
  }

  isClosing(id: string): boolean {
    return this.closing.has(id);
  }

  clear(): void {
    this.closed.clear();
  }

  async close(id: string): Promise<WaitAgentStatus> {
    const pending = this.closing.get(id);
    if (pending) {
      await pending;
      return "shutdown";
    }
    if (this.closed.has(id)) return "shutdown";

    const target = this.agents.get(id);
    if (!target) throw new Error(`agent with id ${id} not found`);
    const previousStatus = getAgentStatus(target);
    const records = this.openSubtree(target);
    let operation!: Promise<void>;
    operation = Promise.resolve().then(async () => {
      const prepared = new Map<string, PreparedClose>();

      // Preserve Codex's target-first shutdown order, but request every stop before
      // awaiting any runner so a stalled parent cannot leave descendants running.
      for (const record of records) {
        const owner = this.closing.get(record.id);
        if (owner === operation) prepared.set(record.id, this.prepareClose(record));
      }

      const results = await Promise.allSettled(
        records.map((record) => {
          const owner = this.closing.get(record.id);
          const claimed = prepared.get(record.id);
          return claimed ? this.finishClose(claimed) : (owner ?? Promise.resolve());
        }),
      );
      const failure = results.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (failure) throw failure.reason;
    });
    for (const record of records) {
      if (!this.closing.has(record.id)) this.closing.set(record.id, operation);
    }
    try {
      await operation;
    } finally {
      for (const record of records) {
        if (this.closing.get(record.id) === operation) this.closing.delete(record.id);
      }
    }
    return previousStatus;
  }

  private openSubtree(target: AgentRecord): AgentRecord[] {
    const all = [...this.agents.values()];
    const result: AgentRecord[] = [];
    const seen = new Set<string>();
    const pending = [target];
    while (pending.length > 0) {
      const record = pending.shift();
      if (!record || seen.has(record.id)) continue;
      seen.add(record.id);
      result.push(record);
      let sessionId: string | undefined;
      try {
        sessionId = record.session?.sessionManager.getSessionId();
      } catch {}
      if (sessionId === undefined) continue;
      for (const candidate of all) {
        if (!seen.has(candidate.id) && candidate.parentSessionId === sessionId) {
          pending.push(candidate);
        }
      }
    }
    return result;
  }

  private prepareClose(record: AgentRecord): PreparedClose {
    const prepared = {
      record,
      holdsReservation: this.hooks.hasSlot(record),
    };
    if (record.status === "running" || record.status === "queued") this.hooks.abort(record.id);
    return prepared;
  }

  private async finishClose({ record, holdsReservation }: PreparedClose): Promise<void> {
    if (!this.hooks.canRemove(record) && record.promise) await record.promise;
    const tombstone = this.buildClosedRecord(record);

    try {
      if (record.session) await this.hooks.teardown(record);
    } finally {
      if (holdsReservation) this.hooks.releaseReservation(record);
      record.session = undefined;
      if (this.agents.get(record.id) === record) this.agents.delete(record.id);
      this.closed.set(record.id, tombstone);
    }
  }

  private buildClosedRecord(record: AgentRecord): ClosedAgentRecord {
    let sessionFile: string | undefined;
    try {
      sessionFile = record.session?.sessionFile;
    } catch {}
    return sessionFile
      ? {
          id: record.id,
          recoverable: true,
          sessionFile,
          type: record.type,
          parentSessionId: record.parentSessionId,
          description: record.description,
        }
      : { id: record.id, recoverable: false };
  }
}
