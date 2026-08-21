import { describe, expect, it, vi } from "vitest";
import { createAgentCompletionHandler } from "../agent-completion.js";
import type { AgentRecord } from "../types.js";

function makeRecord(id: string, overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id,
    type: "general",
    parentSessionId: "parent-session",
    prompt: `task ${id}`,
    description: `agent ${id}`,
    status: "completed",
    result: `result ${id}`,
    toolUses: 0,
    startedAt: 100,
    completedAt: 200,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    compactionCount: 0,
    ...overrides,
  };
}

function makeHarness(records: AgentRecord[] = []) {
  const byId = new Map(records.map((record) => [record.id, record]));
  const pi = {
    events: { emit: vi.fn() },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  };
  const onAgentFinishedUI = vi.fn();
  const completion = createAgentCompletionHandler({
    pi: pi as any,
    getRecord: (id) => byId.get(id),
    onAgentFinishedUI,
  });
  return { completion, pi, onAgentFinishedUI };
}

describe("agent completion delivery", () => {
  it("automatically queues an unconsumed completion at the safe steering boundary", () => {
    const record = makeRecord("a");
    const { completion, pi, onAgentFinishedUI } = makeHarness([record]);

    completion.onAgentComplete(record);

    expect(onAgentFinishedUI).toHaveBeenCalledWith("a");
    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: "subagent-notification", display: true }),
      { deliverAs: "steer", triggerTurn: true },
    );
    completion.dispose();
  });

  it("notifies manager-spawned agents that have no inline result surface", () => {
    const record = makeRecord("a");
    const { completion, pi } = makeHarness([record]);

    completion.onAgentComplete(record);

    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("<task-id>a</task-id>") }),
      { deliverAs: "steer", triggerTurn: true },
    );
    completion.dispose();
  });

  it("sends the full final response while keeping display details concise", () => {
    const result = "x".repeat(1_000) + "final marker";
    const record = makeRecord("a", { result });
    const { completion, pi } = makeHarness([record]);

    completion.onAgentComplete(record);

    const notification = pi.sendMessage.mock.calls[0]?.[0];
    expect(notification.content).toContain(`<result>${result}</result>`);
    expect(notification.details.resultPreview).toBe("x".repeat(500) + "…");
    completion.dispose();
  });

  it("delivers the same terminal transition exactly once", () => {
    const record = makeRecord("a");
    const { completion, pi } = makeHarness([record]);

    completion.onAgentComplete(record);
    completion.onAgentComplete(record);

    expect(pi.sendMessage).toHaveBeenCalledOnce();
    expect(pi.appendEntry).toHaveBeenCalledOnce();
    completion.dispose();
  });

  it("emits and persists a failed lifecycle record", () => {
    const record = makeRecord("a", { status: "error", error: "boom" });
    const { completion, pi } = makeHarness([record]);

    completion.onAgentComplete(record);

    expect(pi.events.emit).toHaveBeenCalledWith(
      "subagents:failed",
      expect.objectContaining({ id: "a", error: "boom" }),
    );
    expect(pi.appendEntry).toHaveBeenCalledWith(
      "subagents:record",
      expect.objectContaining({ id: "a", error: "boom" }),
    );
    completion.dispose();
  });
});
