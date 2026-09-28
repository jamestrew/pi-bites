import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  fauxAssistantMessage,
  getApiProvider,
  registerFauxProvider,
  type TranscriptContext,
} from "@earendil-works/pi-ai/compat";
import { harness } from "./helpers/v2-harness.js";

vi.setConfig({ testTimeout: 30_000 });
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

async function setup() {
  const cwd = mkdtempSync(join(tmpdir(), "v2-mail-"));
  const faux = registerFauxProvider({
    provider: "v2-mail",
    models: [{ id: "test-model", contextWindow: 200_000 }],
  });
  const model = faux.getModel();
  const h = harness(cleanup);
  cleanup.push(async () => {
    faux.unregister();
    rmSync(cwd, { recursive: true, force: true });
  });
  h.pi.getActiveTools = () => [
    "spawn_agent",
    "list_agents",
    "send_message",
    "followup_task",
    "read",
  ];
  h.pi.exec = async () => ({ code: 1, stdout: "", stderr: "" });
  h.ctx.cwd = cwd;
  h.ctx.model = model;
  h.ctx.modelRegistry = {
    ...h.ctx.modelRegistry,
    getAvailable: () => [model],
    getRegisteredProviderIds: () => [model.provider],
    getRegisteredProviderConfig: () => ({
      api: faux.api,
      baseUrl: model.baseUrl,
      apiKey: "faux",
      models: [model],
      streamSimple: getApiProvider(faux.api)!.streamSimple,
    }),
  };
  await h.emit("session_start");
  const manager = Reflect.get(globalThis, Symbol.for("pi-subagents:manager"));
  return { ...h, faux, manager };
}

it("queues attributed information without waking an idle agent and later delivers it exactly once", async () => {
  const h = await setup();
  const requests: TranscriptContext[] = [];
  h.faux.setResponses(
    Array.from({ length: 2 }, () => (ctx: TranscriptContext) => {
      requests.push(structuredClone(ctx));
      return fauxAssistantMessage("done");
    }),
  );
  await h.call("spawn_agent", { task_name: "a", message: "first", fork_turns: "none" });
  await h.manager.waitForAll();
  const sent = await h.call("send_message", { target: "a", message: "UNIQUE INFORMATION" });
  expect(sent.content).toEqual([{ type: "text", text: "" }]);
  expect(requests).toHaveLength(1);
  const followup = await h.call("followup_task", { target: "a", message: "NEXT TASK" });
  expect(followup.content).toEqual([{ type: "text", text: "" }]);
  await h.manager.waitForAll();
  expect(requests).toHaveLength(2);
  const payload = JSON.stringify(requests[1]);
  expect(payload.match(/UNIQUE INFORMATION/g)).toHaveLength(1);
  expect(payload.match(/NEXT TASK/g)).toHaveLength(1);
  expect(payload).toContain("<sender_id>/root</sender_id>");
});

it("validates both messaging tools before delivery and rejects root follow-up, foreign trees and unloaded targets", async () => {
  const h = await setup();
  h.faux.setResponses([fauxAssistantMessage("done")]);
  let id = "";
  h.pi.events.on("subagents:created", (event: any) => {
    id = event.id;
  });
  await h.call("spawn_agent", { task_name: "a", message: "first", fork_turns: "none" });
  await h.manager.waitForAll();
  const session = h.manager.getRecord(id).session;
  const before = session.messages.length;
  for (const name of ["send_message", "followup_task"]) {
    for (const args of [
      { target: "a", message: " \n" },
      { target: "", message: "x" },
      { target: "/outside/a", message: "x" },
      { target: "missing", message: "x" },
      { target: "a", message: "x", extra: true },
    ])
      await expect(h.call(name, args)).rejects.toThrow();
    const foreign = h.controller.capture({
      ...h.ctx,
      sessionManager: { getSessionId: () => "foreign", buildContextEntries: () => [] },
    });
    await expect(
      foreign.execute(
        name as "send_message",
        { target: id, message: "x" },
        { callerId: "foreign", callId: name },
      ),
    ).rejects.toThrow("owned");
  }
  await expect(h.call("followup_task", { target: "/root", message: "x" })).rejects.toThrow("root");
  expect(session.messages).toHaveLength(before);
  await h.manager.disposeRuntime(id);
  await expect(h.call("send_message", { target: "a", message: "x" })).rejects.toThrow("loaded");
  await expect(h.call("followup_task", { target: "a", message: "x" })).rejects.toThrow("loaded");
});

it("routes attributed sibling and parent information without waking the sibling", async () => {
  const h = await setup();
  const requests: TranscriptContext[] = [];
  h.faux.setResponses([
    fauxAssistantMessage("sibling done"),
    () => ({
      ...fauxAssistantMessage(""),
      stopReason: "toolUse" as const,
      content: [
        {
          type: "toolCall" as const,
          id: "to-parent",
          name: "send_message",
          arguments: { target: "/root", message: "PARENT INFO" },
        },
        {
          type: "toolCall" as const,
          id: "to-sibling",
          name: "send_message",
          arguments: { target: "/root/a", message: "SIBLING INFO" },
        },
      ],
    }),
    (ctx) => {
      requests.push(structuredClone(ctx));
      return fauxAssistantMessage("sender done");
    },
    (ctx) => {
      requests.push(structuredClone(ctx));
      return fauxAssistantMessage("sibling resumed");
    },
  ]);
  await h.call("spawn_agent", { task_name: "a", message: "first", fork_turns: "none" });
  await h.manager.waitForAll();
  await h.call("spawn_agent", { task_name: "b", message: "send updates", fork_turns: "none" });
  await h.manager.waitForAll();
  expect(requests).toHaveLength(1);
  expect(h.pi.sendMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      details: expect.objectContaining({
        sender: { id: "/root/b", type: "default", title: "/root/b" },
        message: "PARENT INFO",
      }),
    }),
    { triggerTurn: false },
  );
  const results = requests[0]!.messages.filter((m) => m.role === "toolResult");
  expect(results.map((m) => m.content)).toEqual([
    [{ type: "text", text: "" }],
    [{ type: "text", text: "" }],
  ]);
  await h.call("followup_task", { target: "a", message: "read update" });
  await h.manager.waitForAll();
  expect(JSON.stringify(requests[1])).toContain("<sender_id>/root/b</sender_id>");
  expect(JSON.stringify(requests[1]).match(/SIBLING INFO/g)).toHaveLength(1);
});

it.each(["tool batch", "final output", "settlement"])(
  "delivers concurrent work at the supported %s boundary without abort or a double start",
  async (boundary) => {
    const h = await setup();
    const requests: TranscriptContext[] = [];
    const submissions: Promise<unknown>[] = [];
    let id = "";
    h.pi.events.on("subagents:created", (event: any) => {
      id = event.id;
    });
    const starts: unknown[] = [];
    h.pi.events.on("subagents:started", (event: unknown) => starts.push(event));
    h.faux.setResponses([
      (ctx) => {
        requests.push(structuredClone(ctx));
        return boundary === "tool batch"
          ? {
              ...fauxAssistantMessage(""),
              stopReason: "toolUse" as const,
              content: [1, 2].map((n) => ({
                type: "toolCall" as const,
                id: `read-${n}`,
                name: "read",
                arguments: { path: "missing-file" },
              })),
            }
          : fauxAssistantMessage("first final");
      },
      (ctx) => {
        requests.push(structuredClone(ctx));
        return fauxAssistantMessage("final after tasks");
      },
    ]);
    await h.call("spawn_agent", { task_name: "a", message: "first", fork_turns: "none" });
    const session = h.manager.getRecord(id).session;
    let injected = false;
    const unsub = session.subscribe((event: any) => {
      if (
        injected ||
        (boundary === "tool batch"
          ? event.type !== "tool_execution_start"
          : boundary === "settlement"
            ? event.type !== "agent_settled"
            : event.type !== "message_end" || event.message.role !== "assistant")
      )
        return;
      injected = true;
      submissions.push(h.call("send_message", { target: "a", message: "BOUNDARY INFO" }));
      for (const message of ["TASK ONE", "TASK TWO"])
        submissions.push(h.call("followup_task", { target: "a", message }));
    });
    await h.manager.waitForAll();
    unsub();
    await Promise.all(submissions);
    expect(injected).toBe(true);
    expect(requests).toHaveLength(2);
    expect(starts).toHaveLength(1);
    expect(h.manager.getRecord(id).abort).toBeUndefined();
    const payload = JSON.stringify(requests[1]);
    for (const message of ["BOUNDARY INFO", "TASK ONE", "TASK TWO"])
      expect(payload.match(new RegExp(message, "g"))).toHaveLength(1);
    if (boundary === "tool batch")
      expect(requests[1]!.messages.filter((m) => m.role === "toolResult")).toHaveLength(2);
    expect(h.manager.getRecord(id).result).toBe("final after tasks");
  },
);

it("accounts for accepted work after caller cancellation without dereferencing stale contexts", async () => {
  const h = await setup();
  const requests: TranscriptContext[] = [];
  h.faux.setResponses([
    fauxAssistantMessage("done"),
    (ctx) => {
      requests.push(structuredClone(ctx));
      return fauxAssistantMessage("followed up");
    },
  ]);
  await h.call("spawn_agent", { task_name: "a", message: "first", fork_turns: "none" });
  await h.manager.waitForAll();
  const operation = h.controller.capture(h.ctx, { forkContext: false });
  for (const key of Object.keys(h.ctx))
    Object.defineProperty(h.ctx, key, {
      get() {
        throw new Error("stale ctx");
      },
    });
  const cancelled = new AbortController();
  cancelled.abort();
  await expect(
    operation.execute(
      "send_message",
      { target: "a", message: "UNCOMMITTED" },
      { callerId: operation.callerId, callId: "cancelled", signal: cancelled.signal },
    ),
  ).rejects.toThrow();
  const owner = new AbortController();
  const accepted = operation.execute(
    "followup_task",
    { target: "a", message: "ACCEPTED" },
    { callerId: operation.callerId, callId: "accepted", signal: owner.signal },
  );
  owner.abort();
  h.controller.invalidate();
  await accepted;
  await expect(
    operation.execute(
      "followup_task",
      { target: "a", message: "INVALIDATED" },
      { callerId: operation.callerId, callId: "invalidated" },
    ),
  ).rejects.toThrow("owner");
  await h.manager.waitForAll();
  expect(requests).toHaveLength(1);
  const payload = JSON.stringify(requests[0]);
  expect(payload).toContain("ACCEPTED");
  expect(payload).not.toContain("UNCOMMITTED");
  expect(payload).not.toContain("INVALIDATED");
});

it("queues each completed turn's attributed final without waking the parent", async () => {
  const h = await setup();
  h.faux.setResponses([fauxAssistantMessage("FIRST FINAL"), fauxAssistantMessage("SECOND FINAL")]);
  await h.call("spawn_agent", { task_name: "a", message: "first", fork_turns: "none" });
  await h.manager.waitForAll();
  await h.call("followup_task", { target: "a", message: "second" });
  await h.manager.waitForAll();
  expect(
    h.pi.sendMessage.mock.calls.map(([message, options]: any[]) => ({
      sender: message.details.sender.id,
      text: message.details.message,
      options,
    })),
  ).toEqual([
    { sender: "/root/a", text: "FIRST FINAL", options: { triggerTurn: false } },
    { sender: "/root/a", text: "SECOND FINAL", options: { triggerTurn: false } },
  ]);
});
