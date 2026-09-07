import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { AgentRecord } from "./types.js";

type Source = "cancel_and_steer" | "interrupt";
type PendingRedirect = NonNullable<AgentRecord["pendingCancelSteers"]>[number];

interface Hooks {
  isSettled: (record: AgentRecord, generation: number) => boolean;
  onRequest: (record: AgentRecord, source: Source, generation: number) => void;
  onFailure: (record: AgentRecord, error: unknown) => void;
}

/** Owns serialized interruption state transitions for every retained agent. */
export class AgentInterrupter {
  private tails = new WeakMap<AgentRecord, Promise<void>>();

  constructor(private hooks: Hooks) {}

  interrupt(
    record: AgentRecord,
    session: AgentSession,
    source: Source,
    message?: string,
  ): Promise<boolean> {
    const generation = record.generation;
    const promise = record.promise;
    return this.serialize(record, async () => {
      if (!this.isRunningGeneration(record, session, generation, promise)) return false;

      const previousAbort = record.abort;
      const abort = { timestamp: Date.now(), source, reason: source } as const;
      let settleRedirect: (() => void) | undefined;
      const redirect =
        source === "cancel_and_steer"
          ? {
              message: message ?? "",
              settled: new Promise<void>((resolve) => (settleRedirect = resolve)),
              accepted: undefined as boolean | undefined,
            }
          : undefined;
      if (redirect) (record.pendingCancelSteers ??= []).push(redirect);
      else {
        record.pendingCancelSteers = undefined;
        record.status = "stopped";
        record.error = "interrupted";
      }
      record.abort = abort;

      let cleared = { steering: [] as string[], followUp: [] as string[] };
      try {
        this.hooks.onRequest(record, source, generation);
        cleared = session.clearQueue();
        await session.abort();
        const committed = this.owns(record, session, generation, promise, abort, redirect);
        if (redirect) redirect.accepted = committed;
        settleRedirect?.();
        if (!committed) this.removeRedirect(record, redirect);
        return committed;
      } catch (error) {
        const current =
          !this.hooks.isSettled(record, generation) &&
          this.owns(record, session, generation, promise, abort, redirect);
        if (current) {
          this.hooks.onFailure(record, error);
          record.abort = previousAbort;
          if (!redirect) {
            record.status = "running";
            record.error = undefined;
          }
          await this.restoreQueue(record, session, generation, promise, previousAbort, cleared);
        }
        if (redirect) redirect.accepted = false;
        settleRedirect?.();
        this.removeRedirect(record, redirect);
        return false;
      }
    });
  }

  private isRunningGeneration(
    record: AgentRecord,
    session: AgentSession,
    generation: number,
    promise: Promise<string> | undefined,
  ): boolean {
    return (
      record.generation === generation &&
      record.session === session &&
      record.promise === promise &&
      record.status === "running" &&
      !this.hooks.isSettled(record, generation)
    );
  }

  private owns(
    record: AgentRecord,
    session: AgentSession,
    generation: number,
    promise: Promise<string> | undefined,
    abort: AgentRecord["abort"],
    redirect?: PendingRedirect,
  ): boolean {
    return (
      record.generation === generation &&
      record.session === session &&
      record.promise === promise &&
      record.status === (redirect ? "running" : "stopped") &&
      record.abort === abort &&
      (!redirect || !this.hooks.isSettled(record, generation))
    );
  }

  private removeRedirect(record: AgentRecord, redirect?: PendingRedirect): void {
    if (!redirect) return;
    const index = record.pendingCancelSteers?.indexOf(redirect) ?? -1;
    if (index >= 0) record.pendingCancelSteers?.splice(index, 1);
    if (record.pendingCancelSteers?.length === 0) record.pendingCancelSteers = undefined;
  }

  private async restoreQueue(
    record: AgentRecord,
    session: AgentSession,
    generation: number,
    promise: Promise<string> | undefined,
    abort: AgentRecord["abort"],
    messages: { steering: string[]; followUp: string[] },
  ): Promise<void> {
    const current = () =>
      record.generation === generation &&
      record.session === session &&
      record.promise === promise &&
      record.status === "running" &&
      record.abort === abort &&
      !this.hooks.isSettled(record, generation);
    for (const message of messages.steering) {
      if (!current()) return;
      try {
        await session.steer(message);
      } catch {}
    }
    for (const message of messages.followUp) {
      if (!current()) return;
      try {
        await session.followUp(message);
      } catch {}
    }
  }

  private serialize<T>(record: AgentRecord, operation: () => Promise<T>): Promise<T> {
    const result = (this.tails.get(record) ?? Promise.resolve()).then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(record, tail);
    void tail.then(() => {
      if (this.tails.get(record) === tail) this.tails.delete(record);
    });
    return result;
  }
}
