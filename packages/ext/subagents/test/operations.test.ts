import { createNeedsInputLifecycle } from "../../session-tracker/index.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createEventBus, SessionManager } from "@earendil-works/pi-coding-agent";
import registerSubagents from "../index.js";
import { mockCtx, mockSession, waitForCancellation } from "./helpers/agent-manager-mocks.js";
import { runAsSubagent } from "../subagent-context.js";

vi.mock("../agent-runner.js", async (original) => ({
  ...(await original<typeof import("../agent-runner.js")>()),
  runAgent: vi.fn(),
  openAgentSession: vi.fn(),
  resumeAgent: vi.fn(),
}));
vi.mock("../settings.js", () => ({
  applyAndEmitLoaded: vi.fn((settings) => settings.setScopeModels(true)),
}));
import { applyAndEmitLoaded } from "../settings.js";
import { runAgent, openAgentSession } from "../agent-runner.js";

const model = { provider: "test", id: "current", name: "Current", reasoning: true } as any;
const other = { ...model, id: "other", name: "Other" };
const names = ["spawn_agent", "send_input", "wait_agent", "close_agent", "resume_agent"];
const cleanups: (() => Promise<unknown>)[] = [];
beforeEach(() => vi.clearAllMocks());
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.useRealTimers();
});

function harness() {
  const handlers = new Map<string, Function[]>();
  const direct = new Map<string, any>();
  const events = createEventBus();
  const pi = {
    registerTool: (tool: any) => direct.set(tool.name, tool),
    registerCommand: vi.fn(),
    registerMessageRenderer: vi.fn(),
    on: (name: string, fn: Function) => handlers.set(name, [...(handlers.get(name) ?? []), fn]),
    events: { ...events, emit: vi.fn(events.emit) },
    sendMessage: vi.fn(),
    appendEntry: vi.fn(),
    getActiveTools: vi.fn(() => [...names, "read"]),
    getThinkingLevel: vi.fn(() => "high"),
  } as any;
  const sessionManager = SessionManager.inMemory("/tmp", { id: "parent-session" });
  sessionManager.appendMessage({ role: "user", content: "remember this history", timestamp: 1 });
  const ctx = {
    ...mockCtx,
    sessionManager,
    model,
    scopedModels: [{ model }],
    modelRegistry: { ...mockCtx.modelRegistry, getAvailable: () => [model, other] },
    ui: { notify: vi.fn(), setWidget: vi.fn(), setStatus: vi.fn() },
    hasUI: false,
  } as any;
  const controller = registerSubagents(pi);
  const emit = async (name: string) => {
    await Promise.all((handlers.get(name) ?? []).map((fn) => fn({}, ctx)));
  };
  void emit("session_start");
  cleanups.push(() => emit("session_shutdown"));
  const capture = (forkContext = false) => controller.capture(ctx, { forkContext });
  return { controller, pi, ctx, direct, emit, capture };
}
const call = (callId: string, signal?: AbortSignal) => ({
  callerId: "parent-session",
  callId,
  signal,
});
const idOf = (result: { value: unknown }) => (result.value as { agent_id: string }).agent_id;
function pendingChild() {
  vi.mocked(runAgent).mockImplementation((_parent, _type, _prompt, options) =>
    waitForCancellation(options.signal),
  );
}

it("validates nested inputs and caller/capability scope before any launch", async () => {
  pendingChild();
  const h = harness();
  const operation = h.capture();
  for (const args of [
    {},
    { message: 42 },
    { message: "x", extra: true },
    { message: " " },
    { message: "x", agent_type: "missing" },
    { message: "x", reasoning_effort: "extreme" },
  ]) {
    await expect(operation.execute("spawn_agent", args, call("invalid"))).rejects.toThrow();
  }
  await expect(
    operation.execute("spawn_agent", { message: "x" }, { ...call("foreign"), callerId: "other" }),
  ).rejects.toThrow("own");
  h.pi.getActiveTools.mockReturnValue(["read"]);
  await expect(
    h.capture().execute("spawn_agent", { message: "x" }, call("disabled")),
  ).rejects.toThrow("unavailable");
  expect(runAgent).not.toHaveBeenCalled();
});

it("uses throwing-getter snapshots in promise continuations, including requested forks and inherited role", async () => {
  pendingChild();
  const h = harness();
  const operation = runAsSubagent("explorer", () => h.capture(true));
  for (const key of Object.keys(h.ctx))
    Object.defineProperty(h.ctx, key, {
      get: () => {
        throw new Error("stale ctx");
      },
    });
  h.pi.getThinkingLevel.mockImplementation(() => {
    throw new Error("late thinking");
  });
  h.pi.getActiveTools.mockImplementation(() => {
    throw new Error("late tools");
  });
  const spawned = await Promise.resolve().then(() =>
    operation.execute("spawn_agent", { message: "fork", fork_context: true }, call("fork")),
  );
  expect(spawned.value).toEqual({ agent_id: expect.any(String), nickname: "fork" });
  expect(runAgent).toHaveBeenCalledWith(
    expect.objectContaining({ sessionId: "parent-session", systemPrompt: "parent prompt", model }),
    "explorer",
    "fork",
    expect.objectContaining({
      thinkingLevel: "high",
      allowedTools: [...names, "read"],
      parentEntries: expect.arrayContaining([expect.objectContaining({ type: "message" })]),
    }),
  );
});

it.each(["session_tree", "session_before_switch", "session_shutdown"])(
  "rejects stale nonthrowing captures after %s",
  async (event) => {
    pendingChild();
    const h = harness();
    const old = h.capture();
    await h.emit(event);
    await expect(old.execute("spawn_agent", { message: "late" }, call("late"))).rejects.toThrow(
      "owner",
    );
    expect(runAgent).not.toHaveBeenCalled();
  },
);

it("cancels before publication but keeps committed agents controllable during initialization and result loss", async () => {
  pendingChild();
  const h = harness();
  const operation = h.capture();
  const cancelled = new AbortController();
  cancelled.abort();
  await expect(
    operation.execute("spawn_agent", { message: "never" }, call("never", cancelled.signal)),
  ).rejects.toThrow();
  expect(runAgent).not.toHaveBeenCalled();
  const cell = new AbortController();
  const pending = operation.execute(
    "spawn_agent",
    { message: "owned" },
    call("owned", cell.signal),
  );
  cell.abort(); // publication is synchronous, child initialization is still pending
  const id = idOf(await pending);
  expect(vi.mocked(runAgent).mock.calls[0]?.[3].signal?.aborted).toBe(false);
  const input = await operation.execute(
    "send_input",
    { target: id, message: "still here" },
    call("send"),
  );
  expect(input.value).toEqual({ submission_id: expect.any(String) });
  const closed = await operation.execute("close_agent", { target: id }, call("close"));
  expect(closed.value).toEqual({ previous_status: "running" });
});

it("cancels only one waiter and runs timer updates without captured ctx", async () => {
  vi.useFakeTimers();
  pendingChild();
  const h = harness();
  const operation = h.capture();
  const id = idOf(await operation.execute("spawn_agent", { message: "work" }, call("spawn")));
  const cell = new AbortController();
  const cancelled = expect(
    operation.execute("wait_agent", { targets: [id] }, call("cancelled", cell.signal)),
  ).rejects.toThrow("cancelled");
  const update = vi.fn();
  const waiting = operation.execute(
    "wait_agent",
    { targets: [id], timeout_ms: 10_000 },
    { ...call("waiting"), onUpdate: update },
  );
  for (const key of Object.keys(h.ctx))
    Object.defineProperty(h.ctx, key, {
      get: () => {
        throw new Error("stale ctx");
      },
    });
  cell.abort();
  await cancelled;
  await vi.advanceTimersByTimeAsync(10_000);
  expect((await waiting).value).toEqual({ status: {}, timed_out: true });
  const count = update.mock.calls.length;
  await vi.advanceTimersByTimeAsync(2_000);
  expect(update).toHaveBeenCalledTimes(count);
  expect(vi.mocked(runAgent).mock.calls[0]?.[3].signal?.aborted).toBe(false);
});

it("shares direct and captured operations without manufacturing Pi tool events", async () => {
  pendingChild();
  const h = harness();
  const spawned = await h.direct
    .get("spawn_agent")
    .execute("direct", { message: "direct" }, undefined, undefined, h.ctx);
  expect(JSON.parse(spawned.content[0].text)).toEqual(spawned.value);
  const operation = h.capture();
  await expect(
    operation.execute("send_input", { target: "missing", message: "x" }, call("missing")),
  ).rejects.toThrow("not found");
  await expect(operation.execute("wait_agent", { targets: [] }, call("empty"))).rejects.toThrow(
    "non-empty",
  );
  await operation.execute("close_agent", { target: idOf(spawned) }, call("close"));
  expect(h.pi.events.emit.mock.calls.some(([name]: [string]) => name.startsWith("tool_"))).toBe(
    false,
  );
});

it("reserves and rolls back failed reopen through the captured boundary", async () => {
  const child = mockSession();
  child.sessionManager = SessionManager.inMemory("/tmp", { id: "child" });
  child.sessionManager.appendMessage({ role: "user", content: "saved", timestamp: 1 });
  vi.mocked(runAgent).mockResolvedValue({ responseText: "done", session: child });
  const h = harness();
  const operation = h.capture();
  const id = idOf(await operation.execute("spawn_agent", { message: "remember" }, call("spawn")));
  await operation.execute("wait_agent", { targets: [id] }, call("wait"));
  await operation.execute("close_agent", { target: id }, call("close"));
  vi.mocked(openAgentSession).mockRejectedValueOnce(new Error("loader failed"));
  await expect(operation.execute("resume_agent", { id }, call("failed"))).rejects.toThrow(
    "loader failed",
  );
  vi.mocked(openAgentSession).mockResolvedValueOnce(mockSession());
  expect((await operation.execute("resume_agent", { id }, call("retry"))).value).toEqual({
    status: "pending_init",
  });
});

it("rejects duplicate in-flight identities across snapshots while parallel agents remain unique", async () => {
  pendingChild();
  const h = harness();
  const a = h.capture();
  const b = h.capture();
  const spawned = await Promise.all([
    a.execute("spawn_agent", { message: "one" }, call("one")),
    b.execute("spawn_agent", { message: "two" }, call("two")),
  ]);
  expect(new Set(spawned.map(idOf)).size).toBe(2);
  const cell = new AbortController();
  const waiting = expect(
    a.execute("wait_agent", { targets: [idOf(spawned[0]!)] }, call("same", cell.signal)),
  ).rejects.toThrow("cancelled");
  const duplicate = expect(
    b.execute("wait_agent", { targets: [idOf(spawned[1]!)] }, call("same", cell.signal)),
  ).rejects.toThrow("unique");
  cell.abort();
  await waiting;
  await duplicate;
});

it("retains waiter control when its display consumer loses the result channel", async () => {
  vi.useFakeTimers();
  pendingChild();
  const h = harness();
  const operation = h.capture();
  const id = idOf(await operation.execute("spawn_agent", { message: "owned" }, call("spawn")));
  const waiting = operation.execute(
    "wait_agent",
    { targets: [id], timeout_ms: 10_000 },
    {
      ...call("wait"),
      onUpdate: () => {
        throw new Error("cell result channel closed");
      },
    },
  );
  const result = expect(waiting).resolves.toMatchObject({ value: { status: {}, timed_out: true } });
  await vi.advanceTimersByTimeAsync(10_000);
  await result;
});

it.each(["send_input", "wait_agent"])(
  "renders thrown %s failures without relying on discarded details",
  (name) => {
    const h = harness();
    const tool = h.direct.get(name);
    const state = {};
    const theme = { bold: (s: string) => s, fg: (_color: string, s: string) => s };
    const context = { state, expanded: false, isError: true, toolCallId: "error" };
    const result = tool.renderResult(
      { content: [{ type: "text", text: "operation denied" }] },
      { expanded: false },
      theme,
      context,
    );
    const call = tool.renderCall({ target: "missing", message: "hello" }, theme, context);
    expect([...call.render(100), ...result.render(100)].join("\n")).toContain("operation denied");
  },
);

it("stops old-branch agents without delivering their completion into the new branch", async () => {
  pendingChild();
  const h = harness();
  const operation = h.capture();
  const states: string[] = [];
  const tracker = createNeedsInputLifecycle(
    async (state) => {
      states.push(state);
    },
    async () => false,
    () => {},
  );
  h.pi.events.on("subagents:started", ({ id }: { id: string }) =>
    tracker.backgroundAgentStarted(id),
  );
  h.pi.events.on("subagents:failed", ({ id }: { id: string }) =>
    tracker.backgroundAgentFinished(id),
  );
  await operation.execute("spawn_agent", { message: "old branch" }, call("old"));
  expect(states.at(-1)).toBe("working");
  await h.emit("session_tree");
  await Promise.resolve();
  await Promise.resolve();
  expect(h.pi.sendMessage).not.toHaveBeenCalled();
  expect(
    h.pi.events.emit.mock.calls.filter(([name]: [string]) => name === "subagents:failed"),
  ).toHaveLength(1);
  expect(states.at(-1)).toBe("idle");
});

it("preserves explicit model scope, inherited reasoning, and deferred model selection", async () => {
  pendingChild();
  const h = harness();
  const operation = h.capture();
  await expect(
    operation.execute(
      "spawn_agent",
      { message: "wrong model", model: "test/other" },
      call("outside"),
    ),
  ).rejects.toThrow("Model not in scope");
  expect(runAgent).not.toHaveBeenCalled();
  h.ctx.model = other;
  h.ctx.scopedModels = [{ model: other }];
  const spawned = await operation.execute(
    "spawn_agent",
    { message: "snapshot", model: "test/current" },
    call("inside"),
  );
  expect(spawned.value).toHaveProperty("agent_id");
  expect(vi.mocked(runAgent).mock.calls[0]?.[3]).toMatchObject({ model, thinkingLevel: "high" });
});

it.each(names)(
  "validates the registered direct %s contract through the controller",
  async (name) => {
    pendingChild();
    const h = harness();
    await expect(
      h.direct.get(name).execute("invalid", { unexpected: true }, undefined, undefined, h.ctx),
    ).rejects.toThrow("Invalid arguments");
    expect(runAgent).not.toHaveBeenCalled();
  },
);

it("registers children on the shared tree and preserves caller identity and shared capacity", async () => {
  pendingChild();
  vi.mocked(applyAndEmitLoaded).mockImplementationOnce((settings) => {
    settings.setMaxDepth?.(2);
    settings.setMaxConcurrent(4);
    return {};
  });
  const h = harness();
  const root = h.capture();
  const id = idOf(await root.execute("spawn_agent", { message: "child" }, call("child")));
  const options = vi.mocked(runAgent).mock.calls[0]![3];
  const childHandlers = new Map<string, Function[]>();
  const childPi = {
    ...h.pi,
    on: (name: string, fn: Function) =>
      childHandlers.set(name, [...(childHandlers.get(name) ?? []), fn]),
    sendMessage: vi.fn(),
  };
  const childCtx = {
    ...h.ctx,
    sessionManager: SessionManager.inMemory("/tmp", { id: "child-session" }),
  };
  const session = { ...mockSession(), sessionManager: childCtx.sessionManager };
  options.onSessionCreated?.(session);
  const child = options.registerCollaboration!(childPi);
  for (const fn of childHandlers.get("session_start") ?? []) await fn({}, childCtx);
  const captured = child.capture(childCtx);
  const childCall = (callId: string) => ({ callerId: captured.callerId, callId });
  expect(
    (
      await captured.execute(
        "send_input",
        { target: "parent-session", message: "progress" },
        childCall("up"),
      )
    ).value,
  ).toEqual({ submission_id: expect.any(String) });
  expect(h.pi.sendMessage).toHaveBeenCalled();
  const grandchild = idOf(
    await captured.execute("spawn_agent", { message: "descendant" }, childCall("down")),
  );
  await root.execute("spawn_agent", { message: "sibling" }, call("sibling"));
  await root.execute("spawn_agent", { message: "last slot" }, call("last"));
  await expect(
    captured.execute("spawn_agent", { message: "over budget" }, childCall("over")),
  ).rejects.toThrow("concurrency");
  expect(
    (await root.execute("send_input", { target: grandchild, message: "same tree" }, call("tree")))
      .value,
  ).toEqual({ submission_id: expect.any(String) });
  await expect(captured.execute("close_agent", { target: id }, childCall("self"))).rejects.toThrow(
    "calling agent",
  );
  await root.execute("close_agent", { target: id }, call("close-tree"));
  expect(vi.mocked(runAgent).mock.calls[1]![3].signal?.aborted).toBe(true);
  await expect(
    captured.execute("spawn_agent", { message: "late" }, childCall("late")),
  ).rejects.toThrow();
});

it("enforces the root depth limit before delegation or reopen can reserve capacity", async () => {
  pendingChild();
  const h = harness();
  const root = h.capture();
  await root.execute("spawn_agent", { message: "child" }, call("spawn"));
  const options = vi.mocked(runAgent).mock.calls[0]![3];
  const childCtx = {
    ...h.ctx,
    sessionManager: SessionManager.inMemory("/tmp", { id: "depth-child" }),
  };
  options.onSessionCreated?.({ ...mockSession(), sessionManager: childCtx.sessionManager });
  const child = options.registerCollaboration!({ ...h.pi, on: vi.fn() });
  const operation = child.capture(childCtx);
  const childCall = { callerId: operation.callerId, callId: "depth" };
  await expect(
    operation.execute("spawn_agent", { message: "too deep" }, childCall),
  ).rejects.toThrow("depth");
  await expect(operation.execute("resume_agent", { id: "unknown" }, childCall)).rejects.toThrow(
    "depth",
  );
  expect(runAgent).toHaveBeenCalledTimes(1);
});

it.each(["gpt-6", "unsupported"])(
  "publishes the %s child's own permitted capabilities without widening the tree boundary",
  async (modelId) => {
    pendingChild();
    const h = harness();
    const root = h.capture();
    await root.execute("spawn_agent", { message: "child" }, call("spawn"));
    const options = vi.mocked(runAgent).mock.calls[0]![3];
    const childCtx = {
      ...h.ctx,
      model: { ...model, id: modelId },
      sessionManager: SessionManager.inMemory("/tmp", { id: "child-session" }),
    };
    options.onSessionCreated?.({ ...mockSession(), sessionManager: childCtx.sessionManager });
    const child = options.registerCollaboration!({ ...h.pi, on: vi.fn() }, () => [
      "read",
      "send_input",
    ]);
    const capture = child.capture(childCtx);
    expect(capture.model?.id).toBe(modelId);
    expect(capture.capabilities).toEqual(["send_input"]);
    expect(root.model?.id).toBe("current");
    await expect(
      capture.execute(
        "spawn_agent",
        { message: "forbidden" },
        { callerId: capture.callerId, callId: "forbidden" },
      ),
    ).rejects.toThrow("unavailable");
    const foreignCtx = {
      ...h.ctx,
      sessionManager: SessionManager.inMemory("/tmp", { id: "foreign-root" }),
    };
    const foreign = h.controller.capture(foreignCtx);
    const foreignId = idOf(
      await foreign.execute(
        "spawn_agent",
        { message: "foreign" },
        { callerId: foreign.callerId, callId: "foreign" },
      ),
    );
    await expect(
      capture.execute(
        "send_input",
        { target: foreignId, message: "forbidden" },
        { callerId: capture.callerId, callId: "cross-tree" },
      ),
    ).rejects.toThrow("not owned");
  },
);
