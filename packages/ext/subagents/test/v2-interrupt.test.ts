import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { harness } from "./helpers/v2-harness.js";
import { mockSession } from "./helpers/agent-manager-mocks.js";

vi.mock("../agent-runner.js", async (original) => ({
  ...(await original<typeof import("../agent-runner.js")>()),
  runAgent: vi.fn(),
  resumeAgent: vi.fn(async () => "followed up"),
}));
import { resumeAgent, runAgent } from "../agent-runner.js";
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
  vi.clearAllMocks();
});

it("returns the pre-stop snapshot without waiting for settlement and retains the conversation", async () => {
  const done = Promise.withResolvers<any>();
  const stopped = Promise.withResolvers<void>();
  const session = {
    ...mockSession(),
    sessionManager: SessionManager.inMemory("/tmp"),
    abort: vi.fn(() => stopped.promise),
  };
  vi.mocked(runAgent).mockImplementation((_p, _t, _m, options) => {
    options.onSessionCreated?.(session);
    return done.promise;
  });
  const h = harness(cleanup);
  h.pi.getActiveTools = () => ["spawn_agent", "list_agents", "interrupt_agent", "followup_task"];
  cleanup.unshift(async () => {
    stopped.resolve();
    done.resolve({ session, responseText: "partial output" });
  });
  await h.emit("session_start");
  await h.call("spawn_agent", { task_name: "a", message: "work" });
  const result = await h.call("interrupt_agent", { target: "a" });
  expect(JSON.parse(result.content[0].text)).toEqual({ previous_status: "running" });
  expect(JSON.parse((await h.call("interrupt_agent", { target: "a" })).content[0].text)).toEqual({
    previous_status: "interrupted",
  });
  const cancelled = new AbortController();
  const followup = h.call(
    "followup_task",
    { target: "a", message: "uncommitted" },
    cancelled.signal,
  );
  const rejected = expect(followup).rejects.toThrow();
  cancelled.abort();
  await rejected;
  expect(resumeAgent).not.toHaveBeenCalled();
  const operation = h.controller.capture(h.ctx);
  const replacedFollowup = operation.execute(
    "followup_task",
    { target: "a", message: "old parent" },
    { callerId: operation.callerId, callId: "replaced-followup" },
  );
  const replacedRejected = expect(replacedFollowup).rejects.toThrow();
  const descriptors = Object.getOwnPropertyDescriptors(h.ctx);
  for (const key of Object.keys(h.ctx))
    Object.defineProperty(h.ctx, key, {
      configurable: true,
      get() {
        throw new Error("stale ctx");
      },
    });
  h.controller.invalidate();
  await replacedRejected;
  Object.defineProperties(h.ctx, descriptors);
  expect(resumeAgent).not.toHaveBeenCalled();
  stopped.resolve();
  done.resolve({ session, responseText: "partial output" });
  const manager = Reflect.get(globalThis, Symbol.for("pi-subagents:manager"));
  await manager.waitForAll();
  expect(h.pi.sendMessage).not.toHaveBeenCalled();
  expect(JSON.parse((await h.call("list_agents", {})).content[0].text).agents).toContainEqual({
    agent_name: "/root/a",
    agent_status: "interrupted",
  });
});

async function treeHarness() {
  vi.mocked(runAgent).mockImplementation((_p, _t, _m, options) => {
    const done = Promise.withResolvers<any>();
    const session = { ...mockSession(), sessionManager: SessionManager.inMemory("/tmp") };
    session.abort.mockImplementation(async () => {
      done.resolve({ session, responseText: "" });
    });
    options.signal?.addEventListener("abort", () => done.resolve({ session, responseText: "" }), {
      once: true,
    });
    options.onSessionCreated?.(session);
    return done.promise;
  });
  const h = harness(cleanup);
  const cwd = mkdtempSync(join(tmpdir(), "v2-interrupt-"));
  h.ctx.cwd = cwd;
  cleanup.push(async () => {
    rmSync(cwd, { recursive: true, force: true });
  });
  h.pi.getActiveTools = () => ["spawn_agent", "list_agents", "interrupt_agent", "followup_task"];
  await h.emit("session_start");
  const manager = Reflect.get(globalThis, Symbol.for("pi-subagents:manager"));
  const ids: string[] = [];
  h.pi.events.on("subagents:created", (event: any) => ids.push(event.id));
  return { ...h, manager, ids };
}

it("permits siblings and non-root ancestors, rejects root/self/foreign/unknown targets and preserves descendants", async () => {
  const h = await treeHarness();
  await h.call("spawn_agent", { task_name: "a", message: "work" });
  await h.call("spawn_agent", { task_name: "b", message: "work" });
  const a = h.manager.getRecord(h.ids[0]);
  const aCtx = { ...h.ctx, sessionManager: a.session.sessionManager };
  const child = h.controller.capture(aCtx);
  const call = (target: string) =>
    child.execute(
      "interrupt_agent",
      { target },
      { callerId: child.callerId, callId: crypto.randomUUID() },
    );
  for (const target of ["/root", "/root/a", "missing", "/outside/a", " "])
    await expect(call(target)).rejects.toThrow();
  await child.execute(
    "spawn_agent",
    { task_name: "c", message: "child", fork_turns: "none" },
    { callerId: child.callerId, callId: "spawn-c" },
  );
  const c = h.manager.getRecord(h.ids[2]);
  expect((await call("/root/b")).value).toEqual({ previous_status: "running" });
  const grandchild = h.controller.capture({ ...h.ctx, sessionManager: c.session.sessionManager });
  expect(
    (
      await grandchild.execute(
        "interrupt_agent",
        { target: "/root/a" },
        { callerId: grandchild.callerId, callId: "ancestor" },
      )
    ).value,
  ).toEqual({ previous_status: "running" });
  expect(c.status).toBe("running");
  const foreign = h.controller.capture({
    ...h.ctx,
    sessionManager: SessionManager.inMemory("/tmp"),
  });
  await expect(
    foreign.execute(
      "interrupt_agent",
      { target: c.id },
      { callerId: foreign.callerId, callId: "foreign" },
    ),
  ).rejects.toThrow("owned");
  await h.call("interrupt_agent", { target: "/root/a/c" });
  await h.manager.waitForAll();
  await h.manager.disposeRuntime(a.id);
  expect((await h.call("interrupt_agent", { target: "a" })).value).toEqual({
    previous_status: "not_found",
  });
});

it("cancels uncommitted calls, tolerates throwing getters, and invalidates replaced parents", async () => {
  const h = await treeHarness();
  await h.call("spawn_agent", { task_name: "a", message: "work" });
  const operation = h.controller.capture(h.ctx);
  const original = Object.getOwnPropertyDescriptors(h.ctx);
  for (const key of Object.keys(h.ctx))
    Object.defineProperty(h.ctx, key, {
      configurable: true,
      get() {
        throw new Error("stale ctx");
      },
    });
  const cancelled = new AbortController();
  cancelled.abort();
  await expect(
    operation.execute(
      "interrupt_agent",
      { target: "a" },
      { callerId: operation.callerId, callId: "cancelled", signal: cancelled.signal },
    ),
  ).rejects.toThrow();
  const owner = new AbortController();
  const committed = operation.execute(
    "interrupt_agent",
    { target: "a" },
    { callerId: operation.callerId, callId: "accepted", signal: owner.signal },
  );
  owner.abort();
  h.controller.invalidate();
  expect((await committed).value).toEqual({ previous_status: "running" });
  await expect(
    operation.execute(
      "interrupt_agent",
      { target: "a" },
      { callerId: operation.callerId, callId: "replaced" },
    ),
  ).rejects.toThrow("owner");
  Object.defineProperties(h.ctx, original);
  await h.manager.waitForAll();
});

it("returns settled status unchanged and renders the previous snapshot, not a stop acknowledgment", async () => {
  vi.mocked(runAgent).mockImplementation(async (_p, _t, _m, options) => {
    const session = mockSession();
    options.onSessionCreated?.(session);
    return { session, responseText: "finished" };
  });
  const h = harness(cleanup);
  h.pi.getActiveTools = () => ["spawn_agent", "interrupt_agent"];
  await h.emit("session_start");
  await h.call("spawn_agent", { task_name: "a", message: "work" });
  await Reflect.get(globalThis, Symbol.for("pi-subagents:manager")).waitForAll();
  const result = await h.call("interrupt_agent", { target: "a" });
  expect(result.value).toEqual({ previous_status: { completed: "finished" } });
  const tool = h.direct.get("interrupt_agent");
  const theme = {
    bold: (s: string) => `<b>${s}</b>`,
    fg: (c: string, s: string) => `<${c}>${s}</${c}>`,
  };
  for (const expanded of [false, true]) {
    const context = { state: {}, expanded, isError: false };
    expect(tool.renderResult(result, {}, theme, context).render(120)).toEqual([]);
    expect(tool.renderCall({ target: "a" }, theme, context).render(120)).toEqual([
      "<b>interrupt_agent</b><accent> /root/a interrupt requested</accent>",
      "",
      "<dim>Previous status: completed</dim>",
    ]);
  }
});
