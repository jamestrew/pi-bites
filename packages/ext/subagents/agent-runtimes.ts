import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ClosedAgentRecord } from "./agent-close.js";
import { getAgentSessionId } from "./agent-tree.js";
import { shutdownAgentSession } from "./agent-session-shutdown.js";
import type { AgentRecord } from "./types.js";

/** Owns runtime admission and teardown, never conversation retirement. */
export class AgentRuntimes {
  hasPendingMail = (_record: AgentRecord) => false;
  private claims = new Set<symbol>();
  private protections = new Map<string, number>();
  private touched = new Map<string, number>();
  private clock = 0;
  private teardowns = new Set<Promise<void>>();
  private disposals = new Map<string, Promise<void>>();

  constructor(
    private hooks: {
      records: () => AgentRecord[];
      limit: () => number;
      getRecord: (id: string) => AgentRecord | undefined;
      isClosing: (id: string) => boolean;
      isSettled: (record: AgentRecord) => boolean;
      retain: (record: AgentRecord) => ClosedAgentRecord;
      invalidate: (record: AgentRecord) => void;
    },
  ) {}

  pending(id: string): Promise<void> | undefined {
    return this.disposals.get(id);
  }

  teardown(session: AgentSession, beforeDispose?: () => void): Promise<void> {
    const teardown = shutdownAgentSession(session, "quit", beforeDispose);
    if (!this.teardowns.has(teardown)) {
      this.teardowns.add(teardown);
      void teardown.then(
        () => this.teardowns.delete(teardown),
        () => this.teardowns.delete(teardown),
      );
    }
    return teardown;
  }

  async waitForAll(): Promise<void> {
    await Promise.allSettled(this.disposals.values());
    while (this.teardowns.size > 0) {
      await Promise.allSettled(this.teardowns);
    }
  }

  isDisposing(id: string): boolean {
    return this.disposals.has(id);
  }

  touch(id: string): void {
    this.touched.set(id, ++this.clock);
  }

  protect(id: string): () => void {
    this.protections.set(id, (this.protections.get(id) ?? 0) + 1);
    this.touch(id);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = (this.protections.get(id) ?? 1) - 1;
      if (count) this.protections.set(id, count);
      else this.protections.delete(id);
    };
  }

  private eligible(record: AgentRecord): boolean {
    return (
      !!record.session &&
      !this.hooks.isClosing(record.id) &&
      !this.isDisposing(record.id) &&
      !this.protections.has(record.id) &&
      record.status !== "running" &&
      record.status !== "queued" &&
      this.hooks.isSettled(record) &&
      !record.session.pendingMessageCount &&
      !this.hasPendingMail(record) &&
      !record.pendingSteers?.length &&
      !record.pendingCancelSteers?.length
    );
  }

  /** Claim before awaiting eviction; failure is explicit, never an admission queue.
   * Once disposal is claimed, cancellation does not roll it back.
   */
  async admit(signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted();
    const records = this.hooks.records();
    const loaded = records.filter((r) => r.session && !this.isDisposing(r.id)).length;
    const needed = Math.max(0, loaded + this.claims.size - this.hooks.limit() + 1);
    const candidates = needed
      ? records
          .filter((r) => r.taskName && this.eligible(r))
          .sort((a, b) => (this.touched.get(a.id) ?? 0) - (this.touched.get(b.id) ?? 0))
          .filter((r) => {
            const retained = this.hooks.retain(r);
            return retained.recoverable && "conversation" in retained;
          })
          .slice(0, needed)
      : [];
    if (candidates.length < needed)
      throw new Error("No runtime slot is available: all resident agents are busy or protected.");
    const disposal = Promise.all(candidates.map((r) => this.dispose(r.id)));
    const claim = Symbol();
    this.claims.add(claim);
    const release = () => {
      this.claims.delete(claim);
    };
    try {
      await disposal;
      signal?.throwIfAborted();
      return release;
    } catch (error) {
      release();
      throw error;
    }
  }

  dispose(id: string): Promise<void> {
    const pending = this.disposals.get(id);
    if (pending) return pending;
    const record = this.hooks.getRecord(id);
    if (!record || this.hooks.isClosing(id))
      return Promise.reject(new Error("Subagent owner is closed"));
    const session = record.session;
    if (!session) return Promise.resolve();
    if (!this.eligible(record)) return Promise.reject(new Error("Subagent runtime is busy"));
    const snapshot = this.hooks.retain(record);
    if (!snapshot.recoverable || !("conversation" in snapshot))
      return Promise.reject(new Error("Subagent has no recoverable conversation"));
    getAgentSessionId(record);
    // Claim synchronously before extension cleanup can re-enter or accept input.
    const disposal = Promise.resolve().then(async () => {
      record.incarnation = undefined;
      try {
        try {
          this.hooks.invalidate(record);
        } finally {
          await this.teardown(session, () => {
            // Shutdown hooks flush owned delivery before we retain the final branch.
            const retained = this.hooks.retain(record);
            record.retainedConversation =
              retained.recoverable && "conversation" in retained
                ? retained.conversation
                : snapshot.conversation;
          });
        }
      } finally {
        record.retainedConversation ??= snapshot.conversation;
        record.session = undefined;
        this.disposals.delete(id);
      }
    });
    this.disposals.set(id, disposal);
    return disposal;
  }
}
