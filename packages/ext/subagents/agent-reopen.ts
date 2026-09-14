import type { SubagentContext } from "./operation-context.js";
import type { AgentSession, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { waitForAuthorization as waitForOperation } from "../bash-gate/pending.js";
import type { AgentCloser } from "./agent-close.js";
import type { MessageParent } from "./agent-manager.js";
import { openAgentSession } from "./agent-runner.js";
import { shutdownAgentSession } from "./agent-session-shutdown.js";
import { getAgentStatus } from "./agent-status.js";
import { resolveAgent } from "./agent-types.js";
import { snapshotParent } from "./parent-snapshot.js";
import { assertValidSpawnCwd } from "./spawn-cwd.js";
import type { AgentRecord, WaitAgentStatus } from "./types.js";

export interface ReopenOptions {
  signal?: AbortSignal;
  scopeModels?: boolean;
}

/** Owns reopen claims and rollback; the manager remains the sole capacity owner. */
export class AgentReopener {
  private reopening = new Map<string, Promise<WaitAgentStatus>>();
  private lifetime = new AbortController();
  constructor(
    private agents: Map<string, AgentRecord>,
    private closer: AgentCloser,
    private hooks: {
      reserve: (record: AgentRecord) => boolean;
      release: (record: AgentRecord) => void;
      commit: (record: AgentRecord) => void;
      messageParent?: MessageParent;
      autoCompactionThreshold?: () => number | undefined;
    },
  ) {}

  pending(id: string): Promise<WaitAgentStatus> | undefined {
    return this.reopening.get(id);
  }

  shutdown(): Promise<unknown> {
    this.lifetime.abort();
    return Promise.allSettled(this.reopening.values());
  }

  /** Reopen only an owned conversation. Publication is the cancellation commit point. */
  async open(
    pi: ExtensionAPI,
    ctx: SubagentContext,
    id: string,
    options: ReopenOptions = {},
  ): Promise<WaitAgentStatus> {
    const signal = AbortSignal.any([
      this.lifetime.signal,
      ...[options.signal, ctx.signal].filter((s): s is AbortSignal => !!s),
    ]);
    signal.throwIfAborted();
    if (!id.trim()) throw new Error(`invalid agent id ${id}`);
    const parent = snapshotParent(ctx);
    const active = this.agents.get(id);
    const closed = this.closer.get(id);
    const owner =
      active?.parentSessionId ?? (closed?.recoverable ? closed.parentSessionId : undefined);
    if (owner && owner !== parent.sessionId)
      throw new Error(`agent with id ${id} is not owned by this session`);
    if (this.closer.isClosing(id)) throw new Error(`agent with id ${id} is closing`);
    const pending = this.reopening.get(id);
    if (pending) return waitForOperation(pending, signal);
    if (active) return getAgentStatus(active);
    if (!closed) throw new Error(`agent with id ${id} not found`);
    if (!closed.recoverable || !("conversation" in closed))
      throw new Error(`agent with id ${id} has no recoverable conversation`);
    if (!resolveAgent(closed.type).matched) throw new Error(`Unknown agent type '${closed.type}'.`);
    const conversation = closed.conversation;
    const header = conversation.entries[0];
    if (
      header?.type !== "session" ||
      !header.id ||
      header.id !== conversation.sessionId ||
      header.cwd !== conversation.cwd
    )
      throw new Error(`agent with id ${id} has a corrupt conversation`);
    const ids = new Set<string>();
    let previous: string | null = null;
    for (const entry of conversation.entries.slice(1)) {
      if (
        entry.type === "session" ||
        entry.type === "custom" ||
        !entry.id ||
        ids.has(entry.id) ||
        entry.parentId !== previous
      )
        throw new Error(`agent with id ${id} has a corrupt conversation`);
      ids.add(entry.id);
      previous = entry.id;
    }
    if (
      conversation.entries.some(
        (entry) => entry.type === "compaction" && !ids.has(entry.firstKeptEntryId),
      )
    )
      throw new Error(`agent with id ${id} has a corrupt compaction boundary`);
    assertValidSpawnCwd(conversation.cwd);
    const model = parent.model;
    if (
      !model ||
      !parent.availableModels.some((m) => m.provider === model.provider && m.id === model.id)
    )
      throw new Error("No currently authorized model is available for resume.");
    if (
      options.scopeModels &&
      ctx.scopedModels.length &&
      !ctx.scopedModels.some(({ model: m }) => m.provider === model.provider && m.id === model.id)
    )
      throw new Error("Model not in scope for resume.");
    const allowedTools = ctx.allowedTools ?? pi.getActiveTools();
    const thinkingLevel =
      model.reasoning === false ? "off" : (ctx.thinking ?? pi.getThinkingLevel());
    const record: AgentRecord = {
      id,
      incarnation: randomUUID(),
      type: closed.type,
      parentSessionId: closed.parentSessionId,
      description: closed.description,
      generation: 1,
      prompt: "",
      status: "idle",
      toolUses: 0,
      toolCalls: [],
      omittedToolCalls: 0,
      startedAt: Date.now(),
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
      compactionCount: 0,
      failureHistory: [],
      invocation: { modelName: `${model.provider}/${model.id}`, thinking: thinkingLevel },
    };
    if (!this.hooks.reserve(record))
      throw new Error("No concurrency slot is available. Close an agent before resuming another.");
    const reopen = async () => {
      let session: AgentSession | undefined;
      try {
        session = await openAgentSession(parent, record.type, {
          pi,
          agentId: id,
          agentSessionId: record.incarnation,
          model,
          thinkingLevel,
          conversation,
          allowedTools,
          cwd: conversation.cwd,
          configCwd: parent.cwd,
          signal,
          autoCompactionThreshold: this.hooks.autoCompactionThreshold?.(),
          messageParent: (message) =>
            this.hooks.messageParent?.(
              record.parentSessionId,
              { id, type: record.type, title: record.description },
              message,
            ) ?? false,
        });
        signal.throwIfAborted();
        record.session = session;
        this.hooks.commit(record);
        this.agents.set(id, record);
        this.closer.forget(id);
        return getAgentStatus(record);
      } catch (error) {
        try {
          if (session) await shutdownAgentSession(session);
        } finally {
          this.hooks.release(record);
        }
        throw error;
      } finally {
        this.reopening.delete(id);
      }
    };
    // Register the claim before any loader or extension can re-enter the manager.
    const operation = Promise.resolve().then(reopen);
    this.reopening.set(id, operation);
    return operation;
  }
}
