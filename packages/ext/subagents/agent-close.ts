import { getAgentSessionId } from "./agent-tree.js";
import type { FileEntry } from "@earendil-works/pi-coding-agent";
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
      rootSessionId?: string;
      description: string;
    }
  | {
      id: string;
      recoverable: true;
      conversation: { sessionId: string; cwd: string; entries: FileEntry[] };
      type: SubagentType;
      parentSessionId: string;
      rootSessionId?: string;
      description: string;
    };

type CloseHooks = {
  invalidate: (record: AgentRecord) => void;
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
    return structuredClone(this.closed.get(id));
  }

  forget(id: string): void {
    this.closed.delete(id);
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
      const sessionId = getAgentSessionId(record);
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
    // This is the lifecycle commit point, not the delayed completion UI event.
    this.hooks.invalidate(record);
    // Defer stops until every record is claimed. Each stop runs before awaiting
    // runners, so a stalled or failing parent cannot leave descendants running.
    const stop = Promise.resolve().then(() => {
      if (record.status === "running" || record.status === "queued" || record.status === "idle")
        this.hooks.abort(record.id);
    });
    const results = await Promise.allSettled([stop, record.promise]);
    let tombstone: ClosedAgentRecord = { id: record.id, recoverable: false };
    try {
      try {
        tombstone = this.buildClosedRecord(record);
      } finally {
        if (record.session) await this.hooks.teardown(record);
      }
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
    const metadata = {
      id: record.id,
      recoverable: true as const,
      type: record.type,
      parentSessionId: record.parentSessionId,
      ...(record.rootSessionId ? { rootSessionId: record.rootSessionId } : {}),
      description: record.description,
    };
    const manager = record.session?.sessionManager;
    const header = manager && "getHeader" in manager ? manager.getHeader() : undefined;
    if (manager && header) {
      // Retain the active conversation, not extension state/approvals. Reparent
      // around omitted custom entries so Pi can reconstruct the branch intact.
      const branch = manager.getBranch();
      const skippedBoundaries = new Map<string, string>();
      let nextId: string | undefined;
      for (const entry of [...branch].reverse()) {
        if (entry.type !== "custom") nextId = entry.id;
        else if (nextId) skippedBoundaries.set(entry.id, nextId);
      }
      const entries: FileEntry[] = [header];
      let parentId: string | null = null;
      for (const entry of branch) {
        if (entry.type === "custom") continue;
        // Compaction boundaries may name removed state entries. Advance to the
        // next retained entry so reopening does not silently drop the kept tail.
        entries.push({
          ...entry,
          parentId,
          ...(entry.type === "compaction"
            ? {
                firstKeptEntryId:
                  skippedBoundaries.get(entry.firstKeptEntryId) ?? entry.firstKeptEntryId,
              }
            : {}),
        });
        parentId = entry.id;
      }
      return {
        ...metadata,
        conversation: structuredClone({ sessionId: header.id, cwd: header.cwd, entries }),
      };
    }
    return sessionFile
      ? {
          ...metadata,
          sessionFile,
        }
      : { id: record.id, recoverable: false };
  }
}
