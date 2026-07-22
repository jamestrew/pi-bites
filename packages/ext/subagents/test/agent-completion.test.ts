import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentCompletionHandler } from "../agent-completion.js";
import type { AgentRecord } from "../types.js";

function makeRecord(id: string, overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id,
    type: "general-purpose",
    description: `agent ${id}`,
    status: "completed",
    result: `result ${id}`,
    toolUses: 0,
    startedAt: 100,
    completedAt: 200,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    compactionCount: 0,
    isBackground: true,
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
  const onActionableAgentsChanged = vi.fn();
  const completion = createAgentCompletionHandler({
    pi: pi as any,
    getRecord: (id) => byId.get(id),
    onAgentFinishedUI,
    onActionableAgentsChanged,
  });

  return { completion, pi, onAgentFinishedUI, onActionableAgentsChanged };
}

describe("agent completion notifications", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("sends an individual completion after the hold window", () => {
    const record = makeRecord("a");
    const { completion, pi, onAgentFinishedUI, onActionableAgentsChanged } = makeHarness([record]);

    completion.onAgentComplete(record);

    expect(onAgentFinishedUI).toHaveBeenCalledWith("a");
    expect(onActionableAgentsChanged).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(199);
    expect(pi.sendMessage).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: "subagent-notification", display: true }),
      { deliverAs: "followUp", triggerTurn: true },
    );

    completion.dispose();
  });

  it("notifies for detached agents that have no inline result surface", () => {
    const record = makeRecord("a", { isBackground: undefined });
    const { completion, pi } = makeHarness([record]);

    completion.onAgentComplete(record);
    vi.advanceTimersByTime(200);

    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("<task-id>a</task-id>") }),
      { deliverAs: "followUp", triggerTurn: true },
    );

    completion.dispose();
  });

  it("sends the full final response while keeping display details concise", () => {
    const result = "x".repeat(1_000) + "final marker";
    const record = makeRecord("a", { result });
    const { completion, pi } = makeHarness([record]);

    completion.onAgentComplete(record);
    vi.advanceTimersByTime(200);

    const notification = pi.sendMessage.mock.calls[0]?.[0];
    expect(notification.content).toContain(`<result>${result}</result>`);
    expect(notification.details.resultPreview).toBe("x".repeat(500) + "…");

    completion.dispose();
  });

  it("groups smart-mode agents with their full final responses", () => {
    const a = makeRecord("a", { result: "a".repeat(500) + "end-a" });
    const b = makeRecord("b", { result: "b".repeat(500) + "end-b" });
    const { completion, pi } = makeHarness([a, b]);

    completion.trackSpawned("a", "smart");
    completion.trackSpawned("b", "smart");
    completion.onAgentComplete(a);
    completion.onAgentComplete(b);

    vi.advanceTimersByTime(100);
    expect(pi.sendMessage).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);

    expect(pi.sendMessage).toHaveBeenCalledOnce();
    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringMatching(
          /Background agent group completed: 2 agent\(s\) finished[\s\S]*end-a[\s\S]*end-b/,
        ),
        details: expect.objectContaining({ others: [expect.objectContaining({ id: "b" })] }),
      }),
      { deliverAs: "followUp", triggerTurn: true },
    );

    completion.dispose();
  });

  it("notifies an async agent tracked alongside a smart group", () => {
    const asyncRecord = makeRecord("async");
    const a = makeRecord("a");
    const b = makeRecord("b");
    const { completion, pi } = makeHarness([asyncRecord, a, b]);

    completion.trackSpawned("async", "async");
    completion.trackSpawned("a", "smart");
    completion.trackSpawned("b", "smart");
    completion.onAgentComplete(asyncRecord);
    completion.onAgentComplete(a);
    completion.onAgentComplete(b);

    vi.advanceTimersByTime(300);

    expect(pi.sendMessage).toHaveBeenCalledTimes(2);
    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("<task-id>async</task-id>") }),
      { deliverAs: "followUp", triggerTurn: true },
    );
    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("Background agent group completed: 2 agent(s) finished"),
      }),
      { deliverAs: "followUp", triggerTurn: true },
    );

    completion.dispose();
  });

  it("emits a failed lifecycle event for an error record", () => {
    const record = makeRecord("a", { status: "error", error: "boom" });
    const { completion, pi } = makeHarness([record]);

    completion.onAgentComplete(record);

    expect(pi.events.emit).toHaveBeenCalledWith(
      "subagents:failed",
      expect.objectContaining({
        id: "a",
        error: "boom",
      }),
    );
    expect(pi.events.emit).not.toHaveBeenCalledWith("subagents:completed", expect.anything());

    completion.dispose();
  });

  it("records a foreground completion without notifying the parent", () => {
    const record = makeRecord("a", { isBackground: false });
    const { completion, pi, onAgentFinishedUI, onActionableAgentsChanged } = makeHarness([record]);

    completion.onAgentComplete(record);
    vi.runAllTimers();

    expect(pi.events.emit).toHaveBeenCalledWith(
      "subagents:completed",
      expect.objectContaining({
        id: "a",
        status: "completed",
      }),
    );
    expect(pi.appendEntry).toHaveBeenCalledWith(
      "subagents:record",
      expect.objectContaining({
        id: "a",
        result: "result a",
      }),
    );
    expect(onAgentFinishedUI).toHaveBeenCalledWith("a");
    expect(onActionableAgentsChanged).toHaveBeenCalledOnce();
    expect(pi.sendMessage).not.toHaveBeenCalled();

    completion.dispose();
  });
});
