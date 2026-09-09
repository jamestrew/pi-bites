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
  teardown: (record: AgentRecord) => Promise<void>;
  releaseReservation: (record: AgentRecord) => void;
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
    if (this.closed.has(id)) return "shutdown";
    const target = this.agents.get(id);
    if (!target) throw new Error(`agent with id ${id} not found`);
    const previousStatus = this.isClosing(id) ? "shutdown" : getAgentStatus(target);
    const results = await Promise.allSettled(
      this.openSubtree(target).map((record) => this.closeRecord(record)),
    );
    const failure = results.find((result) => result.status === "rejected");
    if (failure) throw failure.reason;
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

  private closeRecord(record: AgentRecord): Promise<void> {
    const pending = this.closing.get(record.id);
    if (pending) return pending;
    const operation = this.finishClose(record).finally(() => this.closing.delete(record.id));
    this.closing.set(record.id, operation);
    return operation;
  }

  private async finishClose(record: AgentRecord): Promise<void> {
    // Defer stops until every record is claimed. Each stop runs before awaiting
    // runners, so a stalled or failing parent cannot leave descendants running.
    const stop = Promise.resolve().then(() => {
      if (record.status === "running" || record.status === "queued") this.hooks.abort(record.id);
    });
    const results = await Promise.allSettled([stop, record.promise]);
    const tombstone = this.buildClosedRecord(record);
    try {
      if (record.session) await this.hooks.teardown(record);
      const failure = results.find((result) => result.status === "rejected");
      if (failure) throw failure.reason;
    } finally {
      record.session = undefined;
      this.agents.delete(record.id);
      this.closed.set(record.id, tombstone);
      this.hooks.releaseReservation(record);
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
