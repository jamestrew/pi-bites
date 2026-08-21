import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../agent-runner.js")>("../agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../agent-runner.js";
import subagentsExtension from "../index.js";

function makeHarness() {
  const tools = new Map<string, any>();
  const handlers = new Map<string, Array<(event: unknown, ctx: any) => unknown>>();
  const eventHandlers = new Map<string, Array<(data: unknown) => unknown>>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((tool: any) => tools.set(tool.name, tool)),
    registerCommand: vi.fn(),
    on: vi.fn((event: string, handler: (event: unknown, ctx: any) => unknown) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    }),
    events: {
      emit: vi.fn((event: string, data: unknown) => {
        for (const handler of eventHandlers.get(event) ?? []) handler(data);
      }),
      on: vi.fn((event: string, handler: (data: unknown) => unknown) => {
        const list = eventHandlers.get(event) ?? [];
        list.push(handler);
        eventHandlers.set(event, list);
        return () => {
          const current = eventHandlers.get(event) ?? [];
          eventHandlers.set(
            event,
            current.filter((candidate) => candidate !== handler),
          );
        };
      }),
    },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
    getThinkingLevel: vi.fn(() => "off"),
    getActiveTools: vi.fn(() => ["Agent", "WaitAgent", "MessageAgent", "read"]),
    setActiveTools: vi.fn(),
  } as any;
  const ctx = {
    hasUI: false,
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
    cwd: "/tmp",
    model: undefined,
    scopedModels: [],
    modelRegistry: {
      find: vi.fn(),
      getAvailable: vi.fn(() => []),
      getAll: vi.fn(() => []),
      getRegisteredProviderIds: vi.fn(() => []),
      getRegisteredProviderConfig: vi.fn(),
    },
    sessionManager: {
      getSessionId: vi.fn(() => "parent-session"),
      getBranch: vi.fn(() => []),
    },
    getSystemPrompt: vi.fn(() => "parent"),
  } as any;

  subagentsExtension(pi);
  for (const handler of handlers.get("session_start") ?? []) {
    handler({ reason: "startup" }, ctx);
  }

  return {
    pi,
    tools,
    ctx,
    emit(event: string, data: unknown = {}) {
      for (const handler of handlers.get(event) ?? []) handler(data, ctx);
    },
    shutdown() {
      for (const handler of handlers.get("session_shutdown") ?? []) handler({}, ctx);
    },
  };
}

function deferredRun() {
  let resolve!: (value: any) => void;
  let reject!: (error: Error) => void;
  vi.mocked(runAgent).mockReturnValue(
    new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    }),
  );
  return { resolve, reject };
}

async function spawn(tools: Map<string, any>, ctx: any, description = "test agent") {
  return tools
    .get("Agent")
    .execute(
      "agent-call",
      { subagent_type: "general", description, prompt: "do the work" },
      undefined,
      undefined,
      ctx,
    );
}

const agentId = (result: any): string => result.details.agentId;

const waitFor = (tools: Map<string, any>, ctx: any, ids: string[], timeoutMs = 30_000) =>
  tools
    .get("WaitAgent")
    .execute("wait-call", { agent_ids: ids, timeout_ms: timeoutMs }, undefined, undefined, ctx);

describe("spawn-and-wait orchestration", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.useRealTimers());

  it("registers WaitAgent and returns a stable Agent identity without waiting", async () => {
    deferredRun();
    const harness = makeHarness();

    expect([...harness.tools.keys()]).toEqual(expect.arrayContaining(["Agent", "WaitAgent"]));
    expect(harness.tools.get("Agent").parameters.properties).not.toHaveProperty(
      "run_in_background",
    );
    expect(harness.tools.get("WaitAgent").parameters.properties.timeout_ms).toMatchObject({
      minimum: 10_000,
      maximum: 3_600_000,
    });

    const result = await spawn(harness.tools, harness.ctx);

    expect(agentId(result)).toMatch(/\S+/);
    expect(result.details.status).toBe("running");
    expect(result.content[0].text).toContain(`Agent ID: ${agentId(result)}`);
    harness.shutdown();
  });

  it("returns a completed agent's full terminal result and consumes automatic delivery", async () => {
    const child = deferredRun();
    const harness = makeHarness();
    const spawned = await spawn(harness.tools, harness.ctx);
    const waiting = waitFor(harness.tools, harness.ctx, [agentId(spawned)]);

    child.resolve({ responseText: "complete result", session: { dispose: vi.fn() } });
    const result = await waiting;

    expect(result.details).toMatchObject({
      outcome: "terminal",
      timed_out: false,
      agents: [
        expect.objectContaining({
          id: agentId(spawned),
          status: "completed",
          result: "complete result",
        }),
      ],
    });
    expect(result.content[0].text).toContain("complete result");
    expect(harness.pi.sendMessage).not.toHaveBeenCalled();
    harness.shutdown();
  });

  it("does not return or reinject a result already delivered automatically", async () => {
    const child = deferredRun();
    const harness = makeHarness();
    const spawned = await spawn(harness.tools, harness.ctx);
    const id = agentId(spawned);

    child.resolve({ responseText: "automatic result", session: { dispose: vi.fn() } });
    await vi.waitFor(() => expect(harness.pi.sendMessage).toHaveBeenCalledOnce());

    const result = await waitFor(harness.tools, harness.ctx, [id]);

    expect(result.details).toMatchObject({
      outcome: "error",
      message: expect.stringContaining("already delivered"),
      agents: [expect.objectContaining({ id, status: "completed" })],
    });
    expect(result.content[0].text).not.toContain("automatic result");
    expect(harness.pi.sendMessage).toHaveBeenCalledOnce();
    harness.shutdown();
  });

  it("wakes on failure with the complete error", async () => {
    const child = deferredRun();
    const harness = makeHarness();
    const spawned = await spawn(harness.tools, harness.ctx);
    const waiting = waitFor(harness.tools, harness.ctx, [agentId(spawned)]);

    child.reject(new Error("child exploded"));
    const result = await waiting;

    expect(result.details.agents).toEqual([
      expect.objectContaining({ status: "error", error: "child exploded" }),
    ]);
    expect(harness.pi.sendMessage).not.toHaveBeenCalled();
    harness.shutdown();
  });

  it("wakes when a running agent is stopped", async () => {
    vi.mocked(runAgent).mockImplementation((_ctx, _type, _prompt, options) => {
      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
      });
    });
    const harness = makeHarness();
    const spawned = await spawn(harness.tools, harness.ctx);
    const id = agentId(spawned);
    const waiting = waitFor(harness.tools, harness.ctx, [id]);

    harness.pi.events.emit("subagents:rpc:stop", { requestId: "stop-1", agentId: id });
    const result = await waiting;

    expect(result.details.agents).toEqual([
      expect.objectContaining({ id, status: "stopped", error: "aborted" }),
    ]);
    expect(harness.pi.sendMessage).not.toHaveBeenCalled();
    harness.shutdown();
  });

  it("times out without cancelling the agent and releases it for automatic delivery", async () => {
    vi.useFakeTimers();
    const child = deferredRun();
    const harness = makeHarness();
    const spawned = await spawn(harness.tools, harness.ctx);
    const id = agentId(spawned);
    const waiting = waitFor(harness.tools, harness.ctx, [id], 10_000);

    await vi.advanceTimersByTimeAsync(10_000);
    const timedOut = await waiting;

    expect(timedOut.details).toMatchObject({
      outcome: "timeout",
      timed_out: true,
      agents: [expect.objectContaining({ id, status: "running" })],
    });
    expect(harness.pi.sendMessage).not.toHaveBeenCalled();

    child.resolve({ responseText: "late result", session: { dispose: vi.fn() } });
    await vi.waitFor(() => expect(harness.pi.sendMessage).toHaveBeenCalledOnce());
    expect(harness.pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("late result") }),
      { deliverAs: "steer", triggerTurn: true },
    );
    harness.shutdown();
  });

  it("wakes when any selected agent finishes and leaves the others running", async () => {
    const first = deferredRun();
    const harness = makeHarness();
    const firstSpawn = await spawn(harness.tools, harness.ctx, "first");
    const second = deferredRun();
    const secondSpawn = await spawn(harness.tools, harness.ctx, "second");
    const waiting = waitFor(harness.tools, harness.ctx, [
      agentId(firstSpawn),
      agentId(secondSpawn),
    ]);

    second.resolve({ responseText: "second done", session: { dispose: vi.fn() } });
    const result = await waiting;

    expect(result.details.agents).toEqual([
      expect.objectContaining({ id: agentId(firstSpawn), status: "running" }),
      expect.objectContaining({
        id: agentId(secondSpawn),
        status: "completed",
        result: "second done",
      }),
    ]);
    expect(harness.pi.sendMessage).not.toHaveBeenCalled();

    first.resolve({ responseText: "first done", session: { dispose: vi.fn() } });
    await vi.waitFor(() => expect(harness.pi.sendMessage).toHaveBeenCalledOnce());
    harness.shutdown();
  });

  it.each(["active", "idle"])(
    "automatically delivers an unconsumed result at a safe %s parent boundary",
    async (parentState) => {
      const child = deferredRun();
      const harness = makeHarness();
      if (parentState === "active") harness.emit("agent_start");
      else harness.emit("agent_settled");
      await spawn(harness.tools, harness.ctx);

      child.resolve({ responseText: `${parentState} result`, session: { dispose: vi.fn() } });

      await vi.waitFor(() => expect(harness.pi.sendMessage).toHaveBeenCalledOnce());
      expect(harness.pi.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining(`${parentState} result`) }),
        { deliverAs: "steer", triggerTurn: true },
      );
      harness.shutdown();
    },
  );
});
