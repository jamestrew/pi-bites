import { describe, expect, it, vi } from "vitest";
import { createAgentCompletionHandler } from "../agent-completion.js";
import type { AgentRecord } from "../types.js";

function makeRecord(id: string, overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id,
    generation: 1,
    type: "worker",
    parentSessionId: "parent-session",
    prompt: `task ${id}`,
    description: `agent ${id}`,
    status: "completed",
    result: `result ${id}`,
    toolUses: 0,
    toolCalls: [],
    omittedToolCalls: 0,
    startedAt: 100,
    completedAt: 200,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    compactionCount: 0,
    failureHistory: [],
    ...overrides,
  };
}

function makeHarness(
  records: AgentRecord[] = [],
  scheduleAutomatic?: (parentSessionId: string, deliver: () => void, cancel: () => void) => boolean,
) {
  const byId = new Map(records.map((record) => [record.id, record]));
  const pi = {
    events: { emit: vi.fn() },
    sendMessage: vi.fn(),
  };
  const onAgentFinishedUI = vi.fn();
  const completion = createAgentCompletionHandler({
    pi: pi as never,
    getRecord: (id) => byId.get(id),
    onAgentFinishedUI,
    scheduleAutomatic,
  });
  return { completion, pi, onAgentFinishedUI };
}

describe("agent completion delivery", () => {
  it("returns the chronological failure chain while mapping errors to V1 status", async () => {
    const record = makeRecord("a", {
      status: "error",
      result: undefined,
      error: "The operation was aborted.",
      abort: { timestamp: 30, source: "shutdown", reason: "shutdown" },
      failureHistory: [
        { timestamp: 10, phase: "assistant", message: "429 quota exceeded" },
        { timestamp: 20, phase: "assistant", message: "The operation was aborted." },
      ],
    });
    const { completion } = makeHarness([record]);

    const outcome = await completion.waitFor([record.id], 10_000);

    expect(outcome.status).toEqual({ a: { errored: "The operation was aborted." } });
    expect(outcome.agents[0]?.failure_history?.map((failure) => failure.message)).toEqual([
      "429 quota exceeded",
      "The operation was aborted.",
    ]);
    expect(outcome.agents[0]?.abort).toEqual({
      timestamp: 30,
      source: "shutdown",
      reason: "shutdown",
    });
    completion.dispose();
  });

  it("automatically delivers one full sanitized completion notification", () => {
    const record = makeRecord("a", {
      description: "unsafe\u001b]52;c;Y29weQ==\u0007 agent",
      result: `safe\u001b[31m ${"x".repeat(1_000)}final marker`,
    });
    const { completion, pi } = makeHarness([record]);

    completion.onAgentComplete(record);
    completion.onAgentComplete(record);

    expect(pi.sendMessage).toHaveBeenCalledOnce();
    const notification = pi.sendMessage.mock.calls[0]?.[0];
    expect(notification.content).toContain("final marker</result>");
    expect(notification.content).not.toContain("\u001b");
    expect(notification.details.description).toBe("unsafe agent");
    completion.dispose();
  });

  it("keeps explicit wait and automatic notification as independent delivery channels", async () => {
    const record = makeRecord("a", { status: "running", result: undefined });
    let deliver!: () => void;
    const scheduleAutomatic = vi.fn((_parent: string, callback: () => void) => {
      deliver = callback;
      return true;
    });
    const { completion, pi } = makeHarness([record], scheduleAutomatic);
    const waiting = completion.waitFor([record.id], 30_000);

    record.status = "completed";
    record.result = "final result";
    record.completedAt = 300;
    completion.onAgentComplete(record);

    await expect(waiting).resolves.toMatchObject({
      status: { a: { completed: "final result" } },
      agents: [expect.objectContaining({ result: "final result" })],
    });
    expect(pi.sendMessage).not.toHaveBeenCalled();
    deliver();
    expect(pi.sendMessage).toHaveBeenCalledOnce();
    expect(pi.sendMessage.mock.calls[0]?.[0].content).toContain("final result");
    completion.dispose();
  });

  it("does not let notification failure change an explicit wait result", async () => {
    const record = makeRecord("a", { status: "running", result: undefined });
    const { completion, pi } = makeHarness([record]);
    pi.sendMessage.mockImplementation(() => {
      throw new Error("delivery failed");
    });
    const waiting = completion.waitFor([record.id], 30_000);

    record.status = "completed";
    record.result = "wait result";
    completion.onAgentComplete(record);

    await expect(waiting).resolves.toMatchObject({
      status: { a: { completed: "wait result" } },
    });
    completion.dispose();
  });

  it("delivers each retained-session generation once with its own result snapshot", () => {
    const record = makeRecord("a", { generation: 1, result: "first result" });
    const deliveries: Array<() => void> = [];
    const { completion, pi } = makeHarness([record], (_parent, deliver) => {
      deliveries.push(deliver);
      return true;
    });

    completion.onAgentComplete(record, 1);
    record.generation = 2;
    record.result = "second result";
    record.startedAt = 300;
    record.completedAt = 400;
    completion.onAgentComplete(record, 2);

    deliveries.forEach((deliver) => deliver());
    expect(pi.sendMessage).toHaveBeenCalledTimes(2);
    expect(pi.sendMessage.mock.calls[0]?.[0].content).toContain("<result>first result</result>");
    expect(pi.sendMessage.mock.calls[1]?.[0].content).toContain("<result>second result</result>");
    completion.dispose();
  });

  it("resolves a generation snapshot before completion events can start the next turn", async () => {
    const record = makeRecord("a", { status: "running" });
    const { completion, pi } = makeHarness([record]);
    const waiting = completion.waitFor([record.id], 30_000);
    record.status = "completed";
    pi.events.emit.mockImplementation(() => {
      record.generation = 2;
      record.status = "running";
      record.result = undefined;
    });

    completion.onAgentComplete(record, 1);

    await expect(waiting).resolves.toMatchObject({
      status: { a: { completed: "result a" } },
      agents: [expect.objectContaining({ status: "completed", result: "result a" })],
    });
    completion.dispose();
  });

  it("emits a failed lifecycle event even when a listener throws", () => {
    const record = makeRecord("a", { status: "error", error: "boom" });
    const { completion, pi } = makeHarness([record]);
    pi.events.emit.mockImplementation(() => {
      throw new Error("listener failed");
    });

    expect(() => completion.onAgentComplete(record)).not.toThrow();
    expect(pi.sendMessage).toHaveBeenCalledOnce();
    completion.dispose();
  });
});
