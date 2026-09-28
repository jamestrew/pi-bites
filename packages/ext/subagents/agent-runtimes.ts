import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ClosedAgentRecord } from "./agent-close.js";
import { getAgentSessionId } from "./agent-tree.js";
import { shutdownAgentSession } from "./agent-session-shutdown.js";
import type { AgentRecord } from "./types.js";

/** Owns loaded-runtime teardown, not conversation retirement or capacity. */
export class AgentRuntimes {
  private teardowns = new Set<Promise<void>>();
  private disposals = new Map<string, Promise<void>>();

  constructor(
    private hooks: {
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

  /** Internal residency seam. V1 slots remain reserved until conversation close.
   * Only settled runtimes without queued input may unload; admission/reload policy
   * belongs to the later V2 cutover, not this lifecycle prefactor.
   */
  dispose(id: string): Promise<void> {
    const pending = this.disposals.get(id);
    if (pending) return pending;
    const record = this.hooks.getRecord(id);
    if (!record || this.hooks.isClosing(id))
      return Promise.reject(new Error("Subagent owner is closed"));
    const session = record.session;
    if (!session) return Promise.resolve();
    if (
      record.status === "running" ||
      record.status === "queued" ||
      (record.status !== "idle" && !this.hooks.isSettled(record)) ||
      session.pendingMessageCount > 0 ||
      record.pendingSteers?.length ||
      record.pendingCancelSteers?.length
    )
      return Promise.reject(new Error("Subagent runtime is busy"));
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
