import { describe, expect, it, vi } from "vitest";
import { CODEX_V1_CONTRACT } from "../codex-v1-contract.js";
import { createAgentCompletionHandler } from "../agent-completion.js";
import { registerWaitAgent } from "../register-wait-agent.js";
import type { AgentRecord } from "../types.js";

function record(id: string, status: AgentRecord["status"]): AgentRecord {
  return {
    id,
    generation: 1,
    type: "worker",
    parentSessionId: "parent",
    prompt: id,
    description: id,
    status,
    ...(status === "completed" ? { result: `${id} result`, completedAt: 200 } : {}),
    toolUses: 0,
    toolCalls: [],
    omittedToolCalls: 0,
    startedAt: 100,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    compactionCount: 0,
    failureHistory: [],
  };
}

function harness(records: AgentRecord[]) {
  const byId = new Map(records.map((entry) => [entry.id, entry]));
  const pi = {
    events: { emit: vi.fn() },
    sendMessage: vi.fn(),
    registerTool: vi.fn(),
  };
  const completion = createAgentCompletionHandler({
    pi: pi as never,
    getRecord: (id) => byId.get(id),
    onAgentFinishedUI: vi.fn(),
  });
  registerWaitAgent(pi as never, {
    waitFor: completion.waitFor,
    getRecord: (id) => byId.get(id),
  });
  return { completion, pi, tool: pi.registerTool.mock.calls[0]![0] };
}

describe("wait_agent", () => {
  it("registers the pinned V1 model-facing contract without WaitAgent", () => {
    const { completion, tool } = harness([]);

    expect(tool.name).toBe("wait_agent");
    expect(tool.label).toBe("wait_agent");
    expect(tool.description).toBe(CODEX_V1_CONTRACT.tools.wait_agent.description);
    expect(JSON.parse(JSON.stringify(tool.parameters))).toEqual(
      CODEX_V1_CONTRACT.tools.wait_agent.parameters,
    );
    completion.dispose();
  });

  it("returns only already-final and unknown statuses for a mixed duplicate target list", async () => {
    const done = record("done", "completed");
    const running = record("running", "running");
    const { completion } = harness([done, running]);

    await expect(
      completion.waitFor([running.id, done.id, done.id, "missing"], 30_000),
    ).resolves.toMatchObject({
      outcome: "terminal",
      timed_out: false,
      status: {
        done: { completed: "done result" },
        missing: "not_found",
      },
    });
    completion.dispose();
  });

  it("lets concurrent waits observe the same final transition and still notifies once", async () => {
    const running = record("worker", "running");
    const { completion, pi } = harness([running]);
    const first = completion.waitFor([running.id], 30_000);
    const second = completion.waitFor([running.id], 30_000);

    running.status = "completed";
    running.result = "finished";
    running.completedAt = 300;
    completion.onAgentComplete(running);

    await expect(first).resolves.toMatchObject({
      status: { worker: { completed: "finished" } },
    });
    await expect(second).resolves.toMatchObject({
      status: { worker: { completed: "finished" } },
    });
    expect(pi.sendMessage).toHaveBeenCalledOnce();
    completion.dispose();
  });

  it("returns an empty status on timeout without changing the target", async () => {
    vi.useFakeTimers();
    const running = record("worker", "running");
    const { completion } = harness([running]);
    const waiting = completion.waitFor([running.id], 10_000);

    await vi.advanceTimersByTimeAsync(10_000);

    await expect(waiting).resolves.toMatchObject({
      outcome: "timeout",
      status: {},
      timed_out: true,
    });
    expect(running.status).toBe("running");
    completion.dispose();
    vi.useRealTimers();
  });

  it("clamps positive timeouts to the V1 range and rejects zero", async () => {
    let tool: any;
    const waitFor = vi.fn(async (_targets: string[], _timeoutMs: number) => ({
      outcome: "timeout" as const,
      status: {},
      timed_out: true as const,
      agents: [],
    }));
    registerWaitAgent({ registerTool: (registered: unknown) => (tool = registered) } as never, {
      waitFor,
      getRecord: () => undefined,
    });

    await tool.execute("short", { targets: ["a"], timeout_ms: 1 });
    await tool.execute("long", { targets: ["a"], timeout_ms: 4_000_000 });
    const invalid = await tool.execute("zero", { targets: ["a"], timeout_ms: 0 });

    expect(waitFor.mock.calls.map((call) => call[1])).toEqual([10_000, 3_600_000]);
    expect(invalid.content[0].text).toBe("timeout_ms must be greater than zero");
    expect(invalid.details).toMatchObject({
      outcome: "error",
      message: "timeout_ms must be greater than zero",
    });
    expect(
      tool
        .renderResult(
          invalid,
          { expanded: false },
          {
            bold: (text: string) => text,
            fg: (_color: string, text: string) => text,
          },
        )
        .render(80),
    ).toEqual([
      "wait_agent · failed after 0s / timeout 0s",
      "",
      "timeout_ms must be greater than zero",
    ]);
  });

  it("rejects an empty target list without starting a wait", async () => {
    const { completion, tool } = harness([]);

    const result = await tool.execute("empty", { targets: [] });

    expect(result.content[0].text).toBe("agent ids must be non-empty");
    completion.dispose();
  });
});
