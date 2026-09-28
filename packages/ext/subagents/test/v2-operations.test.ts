import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { harness as makeHarness } from "./helpers/v2-harness.js";
import { mockSession, waitForCancellation } from "./helpers/agent-manager-mocks.js";

vi.mock("../agent-runner.js", async (original) => ({
  ...(await original<typeof import("../agent-runner.js")>()),
  runAgent: vi.fn(),
}));
import { runAgent } from "../agent-runner.js";
const harness = () => makeHarness(cleanup);
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
  vi.clearAllMocks();
});

it("spawns and lists named agents through direct tools and the shared manager", async () => {
  vi.mocked(runAgent).mockImplementation(async (_parent, _type, _prompt, options) => {
    const session = mockSession();
    options.onSessionCreated?.(session);
    return waitForCancellation(options.signal);
  });
  const h = harness();
  expect([...h.direct.keys()]).toEqual([
    "spawn_agent",
    "list_agents",
    "send_message",
    "followup_task",
  ]);
  const spawned = await h.call("spawn_agent", { task_name: "research", message: "inspect" });
  expect(JSON.parse(spawned.content[0].text)).toEqual({ task_name: "/root/research" });
  const listed = await h.call("list_agents", {});
  expect(JSON.parse(listed.content[0].text)).toEqual({
    agents: [
      { agent_name: "/root", agent_status: "running" },
      { agent_name: "/root/research", agent_status: "running" },
    ],
  });
  expect(vi.mocked(runAgent).mock.calls[0]?.[3]).toMatchObject({
    thinkingLevel: "high",
    allowedTools: ["spawn_agent", "list_agents", "read"],
    parentEntries: [expect.objectContaining({ type: "message" })],
  });
});

it.each(["", "root", ".", "..", "Upper", "a/b", "é", "a-b"])(
  "rejects invalid task segment %j before initialization",
  async (task_name) => {
    const h = harness();
    await expect(h.call("spawn_agent", { task_name, message: "work" })).rejects.toThrow();
    expect(runAgent).not.toHaveBeenCalled();
  },
);

it("rejects missing/blank messages, unknown fields and unsupported recent-turn forks", async () => {
  const h = harness();
  for (const args of [
    { message: "work" },
    { task_name: "a", message: " " },
    { task_name: "a", message: "x", fork_context: true },
    { task_name: "a", message: "x", fork_turns: "2" },
  ])
    await expect(h.call("spawn_agent", args)).rejects.toThrow();
  expect(runAgent).not.toHaveBeenCalled();
});

function readyChild() {
  vi.mocked(runAgent).mockImplementation(async (_parent, _type, _prompt, options) => {
    const session = mockSession();
    session.sessionManager = SessionManager.inMemory("/tmp", { id: options.agentId });
    options.onSessionCreated?.(session);
    return waitForCancellation(options.signal);
  });
}

it("reserves duplicate paths atomically, while prefixes match whole segments", async () => {
  readyChild();
  const h = harness();
  const calls = await Promise.allSettled(
    [1, 2].map(() => h.call("spawn_agent", { task_name: "a", message: "x" })),
  );
  expect(calls.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
  await h.call("spawn_agent", { task_name: "ab", message: "x" });
  expect(JSON.parse((await h.call("list_agents", { path_prefix: "a" })).content[0].text)).toEqual({
    agents: [{ agent_name: "/root/a", agent_status: "running" }],
  });
});

it.each(["none", " NONE "])(
  "starts fresh for %j but permits an explicit role on full forks",
  async (fork_turns) => {
    readyChild();
    const h = harness();
    await h.call("spawn_agent", { task_name: "fresh", message: "x", fork_turns });
    await h.call("spawn_agent", { task_name: "full", message: "x", agent_type: "explorer" });
    expect(vi.mocked(runAgent).mock.calls[0]?.[3].parentEntries).toBeUndefined();
    expect(vi.mocked(runAgent).mock.calls[1]?.[1]).toBe("explorer");
    expect(vi.mocked(runAgent).mock.calls[1]?.[3].parentEntries).toHaveLength(1);
  },
);

it("releases initialization failures and cancelled reservations for retry", async () => {
  const h = harness();
  vi.mocked(runAgent).mockRejectedValueOnce(new Error("loader failed"));
  await expect(h.call("spawn_agent", { task_name: "a", message: "x" })).rejects.toThrow(
    "loader failed",
  );
  vi.mocked(runAgent).mockImplementationOnce((_parent, _type, _prompt, options) =>
    waitForCancellation(options.signal),
  );
  const owner = new AbortController();
  const cancelled = h.call("spawn_agent", { task_name: "a", message: "x" }, owner.signal);
  owner.abort();
  await expect(cancelled).rejects.toThrow("cancelled");
  readyChild();
  expect((await h.call("spawn_agent", { task_name: "a", message: "x" })).value).toEqual({
    task_name: "/root/a",
  });
});

it("keeps committed agents discoverable after caller cancellation loses a result", async () => {
  readyChild();
  const h = harness();
  const owner = new AbortController();
  const pending = h.call("spawn_agent", { task_name: "a", message: "x" }, owner.signal);
  owner.abort();
  await pending;
  expect(vi.mocked(runAgent).mock.calls[0]?.[3].signal?.aborted).toBe(false);
  expect((await h.call("list_agents", {})).value.agents).toHaveLength(2);
});

it("snapshots context and rejects stale owner captures after navigation", async () => {
  readyChild();
  const h = harness();
  const operation = h.controller.capture(h.ctx);
  for (const key of Object.keys(h.ctx))
    Object.defineProperty(h.ctx, key, {
      get() {
        throw new Error("stale ctx");
      },
    });
  await operation.execute(
    "spawn_agent",
    { task_name: "a", message: "x" },
    { callerId: operation.callerId, callId: "a" },
  );
  h.controller.invalidate();
  await expect(
    operation.execute(
      "spawn_agent",
      { task_name: "b", message: "x" },
      { callerId: operation.callerId, callId: "b" },
    ),
  ).rejects.toThrow("owner");
});

it("shares a root tree with child callers without widening selected tools", async () => {
  readyChild();
  const h = harness();
  await h.call("spawn_agent", { task_name: "parent", message: "x" });
  const options = vi.mocked(runAgent).mock.calls[0]![3];
  const childCtx = {
    ...h.ctx,
    sessionManager: SessionManager.inMemory("/tmp", { id: options.agentId }),
  };
  const child = options.registerCollaboration!({ ...h.pi, on: vi.fn() }, () => [
    "list_agents",
    "read",
  ]);
  const call = child.capture(childCtx);
  expect(call.capabilities).toEqual(["list_agents"]);
  await expect(
    call.execute(
      "spawn_agent",
      { task_name: "denied", message: "x" },
      { callerId: call.callerId, callId: "denied" },
    ),
  ).rejects.toThrow("unavailable");
  expect(
    (
      await call.execute(
        "list_agents",
        { path_prefix: "/root/parent" },
        { callerId: call.callerId, callId: "list" },
      )
    ).value,
  ).toEqual({ agents: [{ agent_name: "/root/parent", agent_status: "running" }] });
  await expect(
    call.execute("list_agents", {}, { callerId: "foreign", callId: "foreign" }),
  ).rejects.toThrow("own");
  const foreign = h.controller.capture({
    ...h.ctx,
    sessionManager: SessionManager.inMemory("/tmp", { id: "foreign" }),
  });
  expect(
    (await foreign.execute("list_agents", {}, { callerId: "foreign", callId: "list" })).value,
  ).toEqual({ agents: [{ agent_name: "/root", agent_status: "running" }] });
});

it("renders safe direct scanlines without duplicate result rows", () => {
  const h = harness();
  const theme = {
    bold: (s: string) => `<b>${s}</b>`,
    fg: (c: string, s: string) => `<${c}>${s}</${c}>`,
  };
  for (const name of ["spawn_agent", "list_agents", "send_message", "followup_task"]) {
    const tool = h.direct.get(name);
    const context = { state: {}, isError: true, expanded: false };
    const row = tool.renderCall({ task_name: "a\nunsafe", path_prefix: "/root" }, theme, context);
    expect(row.render(100)[0]).toMatch(new RegExp(`^<b>${name}</b><accent>`));
    expect(row.render(100)).toHaveLength(1);
    expect(
      tool
        .renderResult({ content: [{ type: "text", text: "denied" }] }, {}, theme, context)
        .render(100),
    ).toEqual([]);
    expect(row.render(100).at(-1)).toBe("<dim>denied</dim>");
    const plain = tool.renderCall(
      { task_name: "很长的名称" },
      { bold: (s: string) => s, fg: (_c: string, s: string) => s },
      context,
    );
    expect(plain.render(8).every((line: string) => visibleWidth(line) <= 8)).toBe(true);
  }
});

it("renders loaded-agent results with expansion", async () => {
  const h = harness();
  const tool = h.direct.get("list_agents");
  const theme = { bold: (s: string) => s, fg: (_c: string, s: string) => s };
  const context = { state: {}, isError: false, expanded: false };
  const row = tool.renderCall({}, theme, context);
  tool.renderResult(
    {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            agents: Array.from({ length: 10 }, (_, i) => ({
              agent_name: `/root/a${i}`,
              agent_status: "running",
            })),
          }),
        },
      ],
    },
    {},
    theme,
    context,
  );
  expect(row.render(100)).toContain("/root/a0 running");
  expect(row.render(100).at(-1)).toContain("to expand");
  context.expanded = true;
  expect(row.render(100).at(-1)).toBe("/root/a9 running");
});

it("keeps loaded terminal agents in list and excludes unloaded runtimes", async () => {
  vi.mocked(runAgent).mockImplementation(async (_parent, _type, _prompt, options) => {
    const session = mockSession();
    session.sessionManager = SessionManager.inMemory("/tmp", { id: options.agentId });
    session.sessionManager.appendMessage({ role: "user", content: "saved", timestamp: 1 });
    options.onSessionCreated?.(session);
    return { responseText: "finished", session };
  });
  const h = harness();
  await h.call("spawn_agent", { task_name: "a", message: "x" });
  const manager = Reflect.get(globalThis, Symbol.for("pi-subagents:manager"));
  await manager.waitForAll();
  expect((await h.call("list_agents", {})).value.agents).toContainEqual({
    agent_name: "/root/a",
    agent_status: { completed: "finished" },
  });
  await manager.disposeRuntime(vi.mocked(runAgent).mock.calls[0]![3].agentId);
  expect((await h.call("list_agents", {})).value.agents).toEqual([
    { agent_name: "/root", agent_status: "running" },
  ]);
});

it("cancels initialization on owner replacement and does not start late", async () => {
  vi.mocked(runAgent).mockImplementation((_parent, _type, _prompt, options) =>
    waitForCancellation(options.signal),
  );
  const h = harness();
  const pending = h.call("spawn_agent", { task_name: "a", message: "x" });
  await h.emit("session_before_switch");
  await expect(pending).rejects.toThrow("cancelled");
  expect(vi.mocked(runAgent).mock.calls[0]?.[3].signal?.aborted).toBe(true);
});

it("reports the loaded root's terminal state to child list callers", async () => {
  const h = harness();
  await h.emit("agent_end", { messages: [] });
  expect((await h.call("list_agents", {})).value.agents).toEqual([
    { agent_name: "/root", agent_status: { completed: null } },
  ]);
  await h.emit("agent_start");
  expect((await h.call("list_agents", {})).value.agents).toEqual([
    { agent_name: "/root", agent_status: "running" },
  ]);
});

it("rejects unnamed registry agents from both named messaging tools before delivery", async () => {
  readyChild();
  const h = harness();
  h.pi.getActiveTools = () => ["send_message", "followup_task"];
  const registry = Reflect.get(globalThis, Symbol.for("pi-subagents:manager"));
  const id = registry.spawn(h.pi, h.ctx, "worker", "registry task", { description: "unnamed" });
  const record = registry.getRecord(id);
  expect(record.session).toBeDefined();
  for (const name of ["send_message", "followup_task"])
    await expect(h.call(name, { target: id, message: "must not arrive" })).rejects.toThrow(
      "no task path",
    );
  expect(record.prompt).toBe("registry task");
  expect(record.session.steer).not.toHaveBeenCalled();
  expect(h.pi.sendMessage).not.toHaveBeenCalled();
});
