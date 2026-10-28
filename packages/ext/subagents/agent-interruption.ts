import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { AgentRecord } from "./types.js";

interface Hooks {
  isSettled: (record: AgentRecord, generation: number) => boolean;
  onFailure: (record: AgentRecord, error: unknown) => void;
}

/** Owns serialized interruption state transitions for every retained agent. */
export class AgentInterrupter {
  private tails = new WeakMap<AgentRecord, Promise<void>>();

  constructor(private hooks: Hooks) {}

  interrupt(record: AgentRecord, session: AgentSession): Promise<boolean> {
    const generation = record.generation;
    const promise = record.promise;
    return this.serialize(record, async () => {
      if (!this.isRunningGeneration(record, session, generation, promise)) return false;

      const previousAbort = record.abort;
      const source = "interrupt";
      const abort = { timestamp: Date.now(), source, reason: source } as const;
      record.status = "stopped";
      record.error = "interrupted";
      record.abort = abort;

      let cleared = { steering: [] as string[], followUp: [] as string[] };
      try {
        cleared = session.clearQueue();
        await session.abort();
        return this.owns(record, session, generation, promise, abort);
      } catch (error) {
        const current =
          !this.hooks.isSettled(record, generation) &&
          this.owns(record, session, generation, promise, abort);
        if (current) {
          this.hooks.onFailure(record, error);
          record.abort = previousAbort;
          record.status = "running";
          record.error = undefined;
          await this.restoreQueue(record, session, generation, promise, previousAbort, cleared);
        }
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
  ): boolean {
    return (
      record.generation === generation &&
      record.session === session &&
      record.promise === promise &&
      record.status === "stopped" &&
      record.abort === abort
    );
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
