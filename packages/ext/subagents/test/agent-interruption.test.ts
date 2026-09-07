import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { expect, test, vi } from "vitest";
import { AgentInterrupter } from "../agent-interruption.js";
import type { AgentRecord } from "../types.js";

test("late abort rejection cannot roll back a settled interrupt", async () => {
  let rejectAbort!: (error: Error) => void;
  const abortPending = new Promise<void>((_, reject) => (rejectAbort = reject));
  let finishTurn!: (result: string) => void;
  const turn = new Promise<string>((resolve) => (finishTurn = resolve));
  const steer = vi.fn();
  const followUp = vi.fn();
  const abort = vi.fn(() => abortPending);
  const clearQueue = vi.fn(() => ({ steering: ["steer"], followUp: ["follow-up"] }));
  const session = { abort, clearQueue, steer, followUp } as unknown as AgentSession;
  const record: AgentRecord = {
    id: "agent-1",
    generation: 1,
    type: "worker",
    parentSessionId: "parent",
    prompt: "task",
    description: "task",
    status: "running",
    toolUses: 0,
    toolCalls: [],
    omittedToolCalls: 0,
    startedAt: Date.now(),
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    compactionCount: 0,
    failureHistory: [],
    session,
    promise: turn,
  };
  let settledGeneration = 0;
  const onFailure = vi.fn();
  const interrupter = new AgentInterrupter({
    isSettled: (_, generation) => settledGeneration >= generation,
    onRequest: vi.fn(),
    onFailure,
  });

  const interrupted = interrupter.interrupt(record, session, "interrupt");
  await Promise.resolve();
  expect(abort).toHaveBeenCalledOnce();
  expect(clearQueue).toHaveBeenCalledOnce();
  expect(record.status).toBe("stopped");
  const requestedAbort = record.abort;

  // The manager settles the retained turn before session.abort() rejects.
  record.completedAt = Date.now();
  settledGeneration = record.generation;
  finishTurn("");
  await turn;
  rejectAbort(new Error("late abort rejection"));

  expect(await interrupted).toBe(false);
  expect(record.status).toBe("stopped");
  expect(record.error).toBe("interrupted");
  expect(record.abort).toBe(requestedAbort);
  expect(onFailure).not.toHaveBeenCalled();
  expect(steer).not.toHaveBeenCalled();
  expect(followUp).not.toHaveBeenCalled();
});
