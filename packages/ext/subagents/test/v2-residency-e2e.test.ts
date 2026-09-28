import { afterEach, expect, it, vi } from "vitest";
import { fauxAssistantMessage, type TranscriptContext } from "@earendil-works/pi-ai/compat";
import { saveSettings } from "../settings.js";
import { setupV2 } from "./helpers/v2-harness.js";
vi.setConfig({ testTimeout: 30_000 });
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});
const setup = () => setupV2(cleanup);

it("reclaims residency under pressure and reloads the same named conversation without starting a turn", async () => {
  const h = await setup();
  h.pi.getActiveTools = () => [
    "spawn_agent",
    "list_agents",
    "send_message",
    "followup_task",
    "interrupt_agent",
    "wait_agent",
  ];
  saveSettings({ maxConcurrent: 1 }, h.ctx.cwd);
  await h.emit("session_start");
  const requests: TranscriptContext[] = [];
  h.faux.setResponses(
    Array.from({ length: 4 }, (_, index) => (ctx: TranscriptContext) => {
      requests.push(structuredClone(ctx));
      return index === 2
        ? {
            ...fauxAssistantMessage(""),
            stopReason: "toolUse" as const,
            content: [
              {
                type: "toolCall" as const,
                id: "wait",
                name: "wait_agent",
                arguments: { timeout_ms: 3_600_000 },
              },
            ],
          }
        : fauxAssistantMessage("done");
    }),
  );
  const ids: string[] = [];
  h.pi.events.on("subagents:created", (e: any) => ids.push(e.id));
  await h.call("spawn_agent", { task_name: "a", message: "ORIGINAL A", fork_turns: "none" });
  await h.manager.waitForAll();
  const a = h.manager.getRecord(ids[0]);
  const incarnation = a.incarnation;
  const sessionId = a.sessionId;
  const usage = { ...a.lifetimeUsage };
  await h.call("spawn_agent", { task_name: "b", message: "B", fork_turns: "none" });
  await h.manager.waitForAll();
  expect(!!a.session).toBe(false);
  expect((await h.call("list_agents", {})).value.agents.map((a: any) => a.agent_name)).toEqual([
    "/root",
    "/root/b",
  ]);
  expect((await h.call("interrupt_agent", { target: "a" })).value).toEqual({
    previous_status: "not_found",
  });
  await h.call("send_message", { target: "a", message: "QUEUED INFO" });
  expect(requests).toHaveLength(2);
  expect(a.sessionId).toBe(sessionId);
  expect(a.incarnation).not.toBe(incarnation);
  expect(a.lifetimeUsage).toEqual(usage);
  expect(!!h.manager.getRecord(ids[1]).session).toBe(false);
  await expect(h.call("spawn_agent", { task_name: "c", message: "C" })).rejects.toThrow(/slot/);
  await h.call("followup_task", { target: "a", message: "FOLLOWUP A" });
  await vi.waitFor(() => expect(a.toolCalls.length).toBe(1));
  expect((await h.call("interrupt_agent", { target: "a" })).value).toEqual({
    previous_status: "running",
  });
  await h.call("followup_task", { target: "a", message: "AFTER INTERRUPT" });
  await h.manager.waitForAll();
  expect(JSON.stringify(requests[3])).toContain("AFTER INTERRUPT");
  expect(JSON.stringify(requests[2])).toContain("ORIGINAL A");
  expect(JSON.stringify(requests[2])).toContain("QUEUED INFO");
  expect(JSON.stringify(requests[2])).toContain("FOLLOWUP A");
});

it("joins concurrent reload/message/follow-up and keeps cancelled waits from cancelling accepted work", async () => {
  const h = await setup();
  const requests: TranscriptContext[] = [];
  h.faux.setResponses(
    Array.from({ length: 2 }, () => (ctx: TranscriptContext) => {
      requests.push(structuredClone(ctx));
      return fauxAssistantMessage("done");
    }),
  );
  let id = "";
  h.pi.events.on("subagents:created", (e: any) => {
    id = e.id;
  });
  await h.call("spawn_agent", { task_name: "a", message: "FIRST", fork_turns: "none" });
  await h.manager.waitForAll();
  await h.manager.disposeRuntime(id);
  const operation = h.controller.capture(h.ctx, { forkContext: false });
  const original = { ...h.ctx };
  for (const key of Object.keys(h.ctx))
    Object.defineProperty(h.ctx, key, {
      configurable: true,
      get() {
        throw new Error("stale ctx");
      },
    });
  const call = (name: "send_message" | "followup_task", message: string, signal?: AbortSignal) =>
    operation.execute(
      name,
      { target: "a", message },
      {
        callerId: operation.callerId,
        callId: message,
        signal,
      },
    );
  const cancelled = new AbortController();
  const waiting = call("send_message", "CANCELLED", cancelled.signal);
  cancelled.abort();
  await expect(waiting).rejects.toThrow();
  await Promise.all([call("send_message", "INFO"), call("followup_task", "WORK")]);
  await h.manager.waitForAll();
  expect(requests).toHaveLength(2);
  const payload = JSON.stringify(requests[1]);
  expect(payload.match(/INFO/g)).toHaveLength(1);
  expect(payload.match(/WORK/g)).toHaveLength(1);
  expect(payload).not.toContain("CANCELLED");
  for (const [key, value] of Object.entries(original))
    Object.defineProperty(h.ctx, key, { configurable: true, writable: true, value });
});

it("cancellation after committed unload releases admission without restoring the evicted runtime or launching late", async () => {
  const h = await setup();
  saveSettings({ maxConcurrent: 1 }, h.ctx.cwd);
  await h.emit("session_start");
  h.faux.setResponses([fauxAssistantMessage("done")]);
  const ids: string[] = [];
  h.pi.events.on("subagents:created", (e: any) => ids.push(e.id));
  await h.call("spawn_agent", { task_name: "a", message: "FIRST", fork_turns: "none" });
  await h.manager.waitForAll();
  const a = h.manager.getRecord(ids[0]);
  const cleanupStarted = Promise.withResolvers<void>();
  const finishCleanup = Promise.withResolvers<void>();
  const emit = a.session.extensionRunner.emit.bind(a.session.extensionRunner);
  a.session.extensionRunner.emit = async (event: any) => {
    if (event.type === "session_shutdown") {
      cleanupStarted.resolve();
      await finishCleanup.promise;
    }
    return emit(event);
  };
  const cancelled = new AbortController();
  const spawning = h.call(
    "spawn_agent",
    { task_name: "b", message: "NEVER START", fork_turns: "none" },
    cancelled.signal,
  );
  const rejected = expect(spawning).rejects.toThrow();
  await cleanupStarted.promise;
  cancelled.abort();
  finishCleanup.resolve();
  await rejected;
  expect(ids).toHaveLength(1);
  expect(!!a.session).toBe(false);
  expect(a.retainedConversation).toBeDefined();
  await h.call("send_message", { target: "a", message: "RECOVERED" });
  expect(!!a.session).toBe(true);
});

it("keeps descendants running and queues their completion for an unloaded parent", async () => {
  const h = await setup();
  h.pi.getActiveTools = () => [
    "spawn_agent",
    "list_agents",
    "send_message",
    "followup_task",
    "wait_agent",
  ];
  saveSettings({ maxConcurrent: 2, maxDepth: 2 }, h.ctx.cwd);
  await h.emit("session_start");
  const requests: TranscriptContext[] = [];
  const tool = (name: string, args: Record<string, string | number>) => ({
    ...fauxAssistantMessage(""),
    stopReason: "toolUse" as const,
    content: [{ type: "toolCall" as const, id: name, name, arguments: args }],
  });
  h.faux.setResponses([
    tool("spawn_agent", { task_name: "leaf", message: "LEAF TASK", fork_turns: "none" }),
    (ctx) =>
      JSON.stringify(ctx).includes("Your canonical task_name is /root/parent/leaf.")
        ? tool("wait_agent", { timeout_ms: 3_600_000 })
        : fauxAssistantMessage("PARENT DONE"),
    (ctx) =>
      JSON.stringify(ctx).includes("Your canonical task_name is /root/parent/leaf.")
        ? tool("wait_agent", { timeout_ms: 3_600_000 })
        : fauxAssistantMessage("PARENT DONE"),
    fauxAssistantMessage("B DONE"),
    fauxAssistantMessage("LEAF FINAL"),
    (ctx) => {
      requests.push(structuredClone(ctx));
      return fauxAssistantMessage("PARENT FOLLOWUP");
    },
  ]);
  const ids: string[] = [];
  h.pi.events.on("subagents:created", (e: any) => ids.push(e.id));
  await h.call("spawn_agent", { task_name: "parent", message: "PARENT TASK", fork_turns: "none" });
  await vi.waitFor(() => expect(ids).toHaveLength(2));
  const parent = h.manager.getRecord(ids[0]);
  const leaf = h.manager.getRecord(ids[1]);
  await vi.waitFor(() => expect(parent.status).toBe("completed"));
  await vi.waitFor(() => expect(leaf.toolCalls.length).toBe(1));
  await h.call("spawn_agent", { task_name: "b", message: "B", fork_turns: "none" });
  await h.manager.getRecord(ids[2]).promise;
  expect(!!parent.session).toBe(false);
  expect(leaf.status).toBe("running");
  expect(leaf.abort).toBeUndefined();
  await h.call("send_message", { target: "/root/parent/leaf", message: "FINISH" });
  await h.manager.waitForAll();
  expect(leaf.result).toBe("LEAF FINAL");
  await h.call("followup_task", { target: "parent", message: "READ CHILD FINAL" });
  await h.manager.waitForAll();
  expect(requests).toHaveLength(1);
  expect(JSON.stringify(requests[0])).toContain("LEAF FINAL");
  expect(JSON.stringify(requests[0])).toContain("<sender_id>/root/parent/leaf</sender_id>");
  expect(h.manager.getRecord(ids[1])).toBe(leaf);
});

it("rechecks the retained model and narrows delegated tools on reload", async () => {
  const h = await setup();
  const requests: TranscriptContext[] = [];
  h.faux.setResponses([
    fauxAssistantMessage("done"),
    (ctx) => {
      requests.push(structuredClone(ctx));
      return fauxAssistantMessage("done again");
    },
  ]);
  let id = "";
  h.pi.events.on("subagents:created", (e: any) => {
    id = e.id;
  });
  await h.call("spawn_agent", { task_name: "a", message: "A", fork_turns: "none" });
  await h.manager.waitForAll();
  await h.manager.disposeRuntime(id);
  const model = h.ctx.model;
  const getAvailable = h.ctx.modelRegistry.getAvailable;
  h.ctx.modelRegistry.getAvailable = () => [];
  await expect(h.call("send_message", { target: "a", message: "NOT AUTHORIZED" })).rejects.toThrow(
    "authorized model",
  );
  h.ctx.modelRegistry.getAvailable = getAvailable;
  h.ctx.model = { ...model, id: "different-parent-model" };
  h.pi.getActiveTools = () => ["followup_task", "bash"];
  await h.call("followup_task", { target: "a", message: "AUTHORIZED" });
  await h.manager.waitForAll();
  expect(h.manager.getRecord(id).session.model.id).toBe(model.id);
  expect(requests).toHaveLength(1);
  expect(h.manager.getRecord(id).session.getActiveToolNames()).not.toContain("read");
  expect(h.manager.getRecord(id).session.getActiveToolNames()).not.toContain("bash");
  expect(JSON.stringify(requests[0])).not.toContain("NOT AUTHORIZED");
});

it("invalidates session approvals across runtime incarnations", async () => {
  const h = await setup();
  h.ctx.hasUI = true;
  const select = vi.fn(async () => 'Allow for session ("touch")');
  h.ctx.ui.select = select;
  h.pi.getActiveTools = () => ["spawn_agent", "followup_task", "bash"];
  const command = {
    ...fauxAssistantMessage(""),
    stopReason: "toolUse" as const,
    content: [
      {
        type: "toolCall" as const,
        id: "command",
        name: "bash",
        arguments: { command: "touch approved.txt" },
      },
    ],
  };
  h.faux.setResponses([
    command,
    fauxAssistantMessage("done"),
    command,
    fauxAssistantMessage("done again"),
  ]);
  let id = "";
  h.pi.events.on("subagents:created", (e: any) => {
    id = e.id;
  });
  await h.emit("agent_start");
  await h.call("spawn_agent", { task_name: "a", message: "A", fork_turns: "none" });
  await h.manager.waitForAll();
  expect(select).toHaveBeenCalledTimes(1);
  const incarnation = h.manager.getRecord(id).incarnation;
  await h.manager.disposeRuntime(id);
  await h.call("followup_task", { target: "a", message: "AGAIN" });
  await h.manager.waitForAll();
  expect(h.manager.getRecord(id).incarnation).not.toBe(incarnation);
  expect(select).toHaveBeenCalledTimes(2);
});

it("evicts least-recently-touched terminal agents and never oversubscribes concurrent admission", async () => {
  const h = await setup();
  saveSettings({ maxConcurrent: 2 }, h.ctx.cwd);
  await h.emit("session_start");
  h.faux.setResponses(Array.from({ length: 6 }, () => fauxAssistantMessage("done")));
  const spawn = (task_name: string) =>
    h.call("spawn_agent", { task_name, message: task_name, fork_turns: "none" });
  await spawn("a");
  await h.manager.waitForAll();
  await spawn("b");
  await h.manager.waitForAll();
  await h.call("followup_task", { target: "a", message: "touch a" });
  await h.manager.waitForAll();
  await spawn("c");
  await h.manager.waitForAll();
  const names = async () =>
    (await h.call("list_agents", {})).value.agents.map((a: any) => a.agent_name);
  expect(await names()).toEqual(["/root", "/root/a", "/root/c"]);
  await Promise.all([spawn("d"), spawn("e")]);
  await h.manager.waitForAll();
  expect(await names()).toEqual(["/root", "/root/d", "/root/e"]);
});

it("retires unloaded identities on root replacement instead of routing into the new root", async () => {
  const h = await setup();
  h.faux.setResponses([fauxAssistantMessage("done")]);
  let id = "";
  h.pi.events.on("subagents:created", (e: any) => {
    id = e.id;
  });
  await h.call("spawn_agent", { task_name: "a", message: "A", fork_turns: "none" });
  await h.manager.waitForAll();
  await h.manager.disposeRuntime(id);
  const captured = h.controller.capture(h.ctx);
  await h.emit("session_before_switch");
  await h.emit("session_start");
  await expect(h.call("send_message", { target: "a", message: "OLD" })).rejects.toThrow("owned");
  await expect(
    captured.execute(
      "send_message",
      { target: "a", message: "STALE" },
      {
        callerId: captured.callerId,
        callId: "stale",
      },
    ),
  ).rejects.toThrow("owner");
  expect(h.manager.getRecord(id)).toBeUndefined();
});
