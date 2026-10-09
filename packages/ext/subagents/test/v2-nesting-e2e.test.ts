import { afterEach, expect, it, vi } from "vitest";
import { fauxAssistantMessage, type TranscriptContext } from "@earendil-works/pi-ai/compat";
import { saveSettings } from "../settings.js";
import { setupV2 } from "./helpers/v2-harness.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

const tool = (name: string, args: Record<string, string | number>) => ({
  ...fauxAssistantMessage(""),
  stopReason: "toolUse" as const,
  content: [{ type: "toolCall" as const, id: crypto.randomUUID(), name, arguments: args }],
});

it("defaults to three shared child slots in addition to root", async () => {
  const h = await setupV2(cleanup);
  h.pi.getActiveTools = () => ["spawn_agent", "list_agents", "wait_agent", "interrupt_agent"];
  h.faux.setResponses(
    Array.from({ length: 4 }, () => tool("wait_agent", { timeout_ms: 3_600_000 })),
  );
  let lastId = "";
  let firstId = "";
  for (const task_name of ["a", "b", "c"]) {
    lastId = (await h.call("spawn_agent", { task_name, message: "wait", fork_turns: "none" }))
      .details.agentId;
    firstId ||= lastId;
  }
  await vi.waitFor(async () => {
    expect((await h.call("list_agents", {})).value.agents).toHaveLength(4);
    expect(h.manager.getRecord(lastId).toolCalls).toHaveLength(1);
  });
  await expect(
    h.call("spawn_agent", { task_name: "d", message: "wait", fork_turns: "none" }),
  ).rejects.toThrow(/slot/);
  await h.call("interrupt_agent", { target: "a" });
  await h.manager.getRecord(firstId).promise;
  await expect(
    h.call("spawn_agent", { task_name: "d", message: "wait", fork_turns: "none" }),
  ).resolves.toMatchObject({ value: { task_name: "/root/d" } });
}, 30_000);

it("spawns three descendant levels by default with canonical paths and immediate-parent finals", async () => {
  const h = await setupV2(cleanup);
  const requests: TranscriptContext[] = [];
  const respond = (ctx: TranscriptContext) => {
    requests.push(structuredClone(ctx));
    const text = JSON.stringify(ctx);
    const hasSpawnResult = ctx.messages.some((m) => m.role === "toolResult");
    if (text.includes("Your canonical task_name is /root/a/b/c."))
      return fauxAssistantMessage("C FINAL");
    if (text.includes("Your canonical task_name is /root/a/b."))
      return hasSpawnResult
        ? fauxAssistantMessage("B FINAL")
        : tool("spawn_agent", {
            task_name: "c",
            message: "third level",
            fork_turns: "none",
          });
    return hasSpawnResult
      ? fauxAssistantMessage("A FINAL")
      : tool("spawn_agent", {
          task_name: "b",
          message: "second level",
          fork_turns: "none",
        });
  };
  h.faux.setResponses(Array.from({ length: 7 }, () => respond));
  await h.call("spawn_agent", { task_name: "a", message: "first level", fork_turns: "none" });
  await h.manager.waitForAll();
  const names = (await h.call("list_agents", {})).value.agents.map((a: any) => a.agent_name);
  expect(names).toEqual(["/root", "/root/a", "/root/a/b", "/root/a/b/c"]);
  await h.call("followup_task", { target: "/root/a/b", message: "read child final" });
  await h.manager.waitForAll();
  await h.call("followup_task", { target: "/root/a", message: "read child final" });
  await h.manager.waitForAll();
  expect(JSON.stringify(requests.at(-2))).toContain("<sender_id>/root/a/b/c</sender_id>");
  expect(JSON.stringify(requests.at(-2))).toContain("C FINAL");
  expect(JSON.stringify(requests.at(-1))).toContain("<sender_id>/root/a/b</sender_id>");
  expect(JSON.stringify(requests.at(-1))).toContain("B FINAL");
  expect(h.pi.sendMessage.mock.calls.map(([m]: any[]) => m.details.sender.id)).toEqual([
    "/root/a",
    "/root/a",
  ]);
}, 30_000);

it("shares capacity and tool ceilings for nested spawns without leaking a rejected path", async () => {
  const h = await setupV2(cleanup);
  h.pi.getActiveTools = () => [
    "spawn_agent",
    "list_agents",
    "wait_agent",
    "interrupt_agent",
    "read",
  ];
  saveSettings({ maxConcurrent: 2 }, h.ctx.cwd);
  await h.emit("session_start");
  const respond = (ctx: TranscriptContext) => {
    const text = JSON.stringify(ctx);
    if (text.includes("Your canonical task_name is /root/a/b/c."))
      return fauxAssistantMessage("C FINAL");
    if (text.includes("Your canonical task_name is /root/a/b."))
      return tool("wait_agent", { timeout_ms: 3_600_000 });
    return ctx.messages.some((m) => m.role === "toolResult")
      ? tool("wait_agent", { timeout_ms: 3_600_000 })
      : tool("spawn_agent", { task_name: "b", message: "second level", fork_turns: "none" });
  };
  h.faux.setResponses(Array.from({ length: 4 }, () => respond));
  const ids: string[] = [];
  h.pi.events.on("subagents:created", (e: any) => ids.push(e.id));
  await h.call("spawn_agent", { task_name: "a", message: "first level", fork_turns: "none" });
  await vi.waitFor(() => expect(ids).toHaveLength(2));
  const a = h.manager.getRecord(ids[0]);
  const b = h.manager.getRecord(ids[1]);
  await vi.waitFor(() => expect(a.toolCalls).toHaveLength(2));
  await vi.waitFor(() => expect(b.toolCalls).toHaveLength(1));
  const child = h.controller.forChild(h.pi, b, () => b.allowedTools);
  const operation = child.capture({ ...h.ctx, sessionManager: b.session.sessionManager });
  const spawn = (callId: string) =>
    operation.execute(
      "spawn_agent",
      {
        task_name: "c",
        message: "third level",
        fork_turns: "none",
      },
      { callerId: operation.callerId, callId },
    );
  await expect(spawn("full")).rejects.toThrow(/slot/);
  expect(ids).toHaveLength(2);
  expect((await h.call("list_agents", {})).value.agents).toHaveLength(3);
  await h.call("interrupt_agent", { target: "a" });
  await a.promise;
  expect((await spawn("retry")).value).toEqual({ task_name: "/root/a/b/c" });
  const c = h.manager.getRecord(ids[2]);
  await c.promise;
  expect(c.allowedTools).toEqual(b.allowedTools);
  expect(c.session.getActiveToolNames()).not.toContain("bash");
  expect(c.session.getActiveToolNames()).not.toContain("write");
  child.invalidate();
  await expect(spawn("replaced")).rejects.toThrow("owner");
  const current = child.capture({ ...h.ctx, sessionManager: b.session.sessionManager });
  const closing = h.manager.close(b.id);
  await expect(
    current.execute(
      "spawn_agent",
      {
        task_name: "late",
        message: "too late",
        fork_turns: "none",
      },
      { callerId: current.callerId, callId: "closing" },
    ),
  ).rejects.toThrow("owner is closed");
  await closing;
  expect(ids).toHaveLength(3);
}, 30_000);
