import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { openAgentSession } from "../agent-runner.js";
import { shutdownAgentSession } from "../agent-session-shutdown.js";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import { setupV2 } from "./helpers/v2-harness.js";

vi.setConfig({ testTimeout: 30_000 });
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

it("rejects fuzzy and cross-provider model overrides before reserving a task", async () => {
  const h = await setupV2(cleanup);
  h.faux.setResponses([fauxAssistantMessage("done")]);
  for (const model of ["test", "missing/test-model"])
    await expect(h.call("spawn_agent", { task_name: "a", message: "work", model })).rejects.toThrow(
      "Model not found",
    );
  expect((await h.call("list_agents", {})).value.agents).toHaveLength(1);
  const result = await h.call("spawn_agent", {
    task_name: "a",
    message: "work",
    model: "test-model",
  });
  expect(result.details.modelName).toBe("v2-mail/test-model");
  await h.manager.waitForAll();
});

it("uses the configured default on full forks and lets an explicit model override it", async () => {
  const h = await setupV2(cleanup);
  const child = h.faux.getModel();
  const parent = { ...child, id: "parent" };
  const provider = h.ctx.modelRegistry.getRegisteredProviderConfig(child.provider);
  h.ctx.model = parent;
  h.ctx.modelRegistry.getAvailable = () => [parent, child];
  h.ctx.modelRegistry.getRegisteredProviderConfig = () => ({
    ...provider,
    models: [parent, child],
  });
  mkdirSync(join(h.ctx.cwd, ".pi"), { recursive: true });
  writeFileSync(
    join(h.ctx.cwd, ".pi/pi-bites.json"),
    JSON.stringify({ subagents: { defaultModel: "test-model" } }),
  );
  await h.emit("session_start");
  h.faux.setResponses([fauxAssistantMessage("done"), fauxAssistantMessage("done")]);
  const inherited = await h.call("spawn_agent", { task_name: "defaulted", message: "work" });
  expect(inherited.details.modelName).toBe("v2-mail/test-model");
  await h.manager.waitForAll();
  const explicit = await h.call("spawn_agent", {
    task_name: "explicit",
    message: "work",
    model: "parent",
  });
  expect(explicit.details.modelName).toBe("v2-mail/parent");
  await h.manager.waitForAll();
});

it("inherits effort without an override but resets it when selecting a model", async () => {
  const h = await setupV2(cleanup);
  const model = { ...h.faux.getModel(), reasoning: true };
  const provider = h.ctx.modelRegistry.getRegisteredProviderConfig(model.provider);
  h.ctx.model = model;
  h.ctx.modelRegistry.getAvailable = () => [model];
  h.ctx.modelRegistry.getRegisteredProviderConfig = () => ({ ...provider, models: [model] });
  mkdirSync(join(h.ctx.cwd, ".pi"), { recursive: true });
  writeFileSync(
    join(h.ctx.cwd, ".pi/settings.json"),
    JSON.stringify({ defaultThinkingLevel: "medium" }),
  );
  h.faux.setResponses([fauxAssistantMessage("done"), fauxAssistantMessage("done")]);
  const inherited = await h.call("spawn_agent", { task_name: "inherited", message: "work" });
  expect(inherited.details.thinking).toBe("high");
  await h.manager.waitForAll();
  const selected = await h.call("spawn_agent", {
    task_name: "selected",
    message: "work",
    model: model.id,
  });
  expect(selected.details.thinking).toBe("medium");
  await h.manager.waitForAll();
});

it("validates effort against the selected model before starting work", async () => {
  const h = await setupV2(cleanup);
  for (const reasoning_effort of ["low", "impossible"])
    await expect(
      h.call("spawn_agent", { task_name: "a", message: "work", reasoning_effort }),
    ).rejects.toThrow("Unsupported reasoning_effort");
  h.faux.getModel().reasoning = true;
  h.faux.getModel().thinkingLevelMap = { high: null };
  await expect(
    h.call("spawn_agent", { task_name: "a", message: "work", reasoning_effort: "high" }),
  ).rejects.toThrow("Supported:");
  expect((await h.call("list_agents", {})).value.agents).toHaveLength(1);
});

it("uses configured effort independently of model and lets explicit effort win", async () => {
  const h = await setupV2(cleanup);
  h.faux.getModel().reasoning = true;
  mkdirSync(join(h.ctx.cwd, ".pi"), { recursive: true });
  writeFileSync(
    join(h.ctx.cwd, ".pi/pi-bites.json"),
    JSON.stringify({ subagents: { defaultReasoningEffort: "low" } }),
  );
  await h.emit("session_start");
  const observed: (string | undefined)[] = [];
  h.faux.setResponses(
    Array.from({ length: 2 }, () => (_context, options) => {
      observed.push(options?.reasoning);
      return fauxAssistantMessage("done");
    }),
  );
  const configured = await h.call("spawn_agent", { task_name: "configured", message: "work" });
  expect(configured.details.thinking).toBe("low");
  await h.manager.waitForAll();
  const explicit = await h.call("spawn_agent", {
    task_name: "explicit",
    message: "work",
    reasoning_effort: "high",
  });
  expect(explicit.details.thinking).toBe("high");
  await h.manager.waitForAll();
  expect(observed).toEqual(["low", "high"]);
});

it("retains the chosen model and effort across unload and follow-up after defaults change", async () => {
  const h = await setupV2(cleanup);
  const child = h.faux.getModel();
  child.reasoning = true;
  const parent = { ...child, id: "parent" };
  const provider = h.ctx.modelRegistry.getRegisteredProviderConfig(child.provider);
  h.ctx.modelRegistry.getAvailable = () => [child, parent];
  h.ctx.modelRegistry.getRegisteredProviderConfig = () => ({
    ...provider,
    models: [child, parent],
  });
  const observed: unknown[] = [];
  h.faux.setResponses(
    Array.from({ length: 2 }, () => (_context, options, _state, model) => {
      observed.push([model.id, options?.reasoning]);
      return fauxAssistantMessage("done");
    }),
  );
  let id = "";
  h.pi.events.on("subagents:created", (event: any) => {
    id = event.id;
  });
  await h.call("spawn_agent", {
    task_name: "a",
    message: "first",
    model: child.id,
    reasoning_effort: "low",
  });
  await h.manager.waitForAll();
  await h.manager.disposeRuntime(id);
  h.ctx.model = parent;
  mkdirSync(join(h.ctx.cwd, ".pi"), { recursive: true });
  writeFileSync(
    join(h.ctx.cwd, ".pi/pi-bites.json"),
    JSON.stringify({ subagents: { defaultModel: "parent", defaultReasoningEffort: "high" } }),
  );
  await h.emit("session_start");
  // Updating configuration and the caller's model must not reselect an existing child.
  await h.call("followup_task", { target: "a", message: "again" });
  await h.manager.waitForAll();
  expect(observed).toEqual([
    ["test-model", "low"],
    ["test-model", "low"],
  ]);
});

it("rejects ambiguous bare model IDs and unavailable configured defaults", async () => {
  const h = await setupV2(cleanup);
  const model = h.faux.getModel();
  h.ctx.modelRegistry.getAvailable = () => [model, { ...model, provider: "another" }];
  await expect(
    h.call("spawn_agent", { task_name: "a", message: "work", model: model.id }),
  ).rejects.toThrow("Ambiguous model");
  mkdirSync(join(h.ctx.cwd, ".pi"), { recursive: true });
  writeFileSync(
    join(h.ctx.cwd, ".pi/pi-bites.json"),
    JSON.stringify({ subagents: { defaultModel: "missing/model" } }),
  );
  await h.emit("session_start");
  await expect(h.call("spawn_agent", { task_name: "a", message: "work" })).rejects.toThrow(
    "Model not found",
  );
  expect((await h.call("list_agents", {})).value.agents).toHaveLength(1);
  h.faux.setResponses([fauxAssistantMessage("done")]);
  const explicit = await h.call("spawn_agent", {
    task_name: "a",
    message: "work",
    model: `${model.provider}/${model.id}`,
  });
  expect(explicit.details.modelName).toBe("v2-mail/test-model");
  await h.manager.waitForAll();
});

it("passes the authenticated root scope into SDK children and forbids descendant broadening", async () => {
  const h = await setupV2(cleanup);
  const inside = h.faux.getModel();
  const outside = { ...inside, id: "outside" };
  const provider = h.ctx.modelRegistry.getRegisteredProviderConfig(inside.provider);
  h.ctx.modelRegistry.getAvailable = () => [inside, outside];
  h.ctx.modelRegistry.getRegisteredProviderConfig = () => ({
    ...provider,
    models: [inside, outside],
  });
  h.ctx.scopedModels = [{ model: inside }];
  h.faux.setResponses([fauxAssistantMessage("done"), fauxAssistantMessage("leaf done")]);
  const result = await h.call("spawn_agent", {
    task_name: "parent",
    message: "work",
    fork_turns: "none",
  });
  await h.manager.waitForAll();
  const parent = h.manager.getRecord(result.details.agentId);
  expect(parent.session.scopedModels.map((entry: any) => entry.model.id)).toEqual(["test-model"]);
  // Native child scope/defaults are not the security boundary.
  parent.session.setScopedModels([]);
  const child = h.controller.forChild(h.pi, parent, () => h.pi.getActiveTools());
  const call = child.capture({
    ...h.ctx,
    scopedModels: [],
    sessionManager: parent.session.sessionManager,
  });
  await expect(
    call.execute(
      "spawn_agent",
      { task_name: "leaf", message: "work", model: "outside", fork_turns: "none" },
      {
        callerId: call.callerId,
        callId: "outside",
      },
    ),
  ).rejects.toThrow("Model not in scope");
  let leafId = "";
  h.pi.events.on("subagents:created", (event: any) => {
    leafId = event.id;
  });
  await call.execute(
    "spawn_agent",
    { task_name: "leaf", message: "work", fork_turns: "none" },
    {
      callerId: call.callerId,
      callId: "inside",
    },
  );
  await h.manager.waitForAll();
  const grandchild = h.manager.getRecord(leafId);
  expect(grandchild.session.scopedModels.map((entry: any) => entry.model.id)).toEqual([
    "test-model",
  ]);
});

it.each(["explicit", "inherited"] as const)(
  "%s spawns retain their model through scope tightening, unload, and later follow-up",
  async (source) => {
    const h = await setupV2(cleanup);
    const outside = h.ctx.model;
    const inside = { ...outside, id: "inside" };
    const provider = h.ctx.modelRegistry.getRegisteredProviderConfig(outside.provider);
    h.ctx.modelRegistry.getAvailable = () => [outside, inside];
    h.ctx.modelRegistry.getAll = () => [outside, inside];
    h.ctx.modelRegistry.find = (provider: string, id: string) =>
      [outside, inside].find((model) => model.provider === provider && model.id === id);
    h.ctx.modelRegistry.getRegisteredProviderConfig = () => ({
      ...provider,
      models: [outside, inside],
    });
    h.faux.setResponses([fauxAssistantMessage("saved"), fauxAssistantMessage("continued")]);
    const id = await h.manager.spawn(h.pi, h.ctx, "worker", "first", {
      description: "retained",
      ...(source === "explicit" ? { model: outside } : {}),
    });
    await h.manager.waitForAll();
    const record = h.manager.getRecord(id);
    expect(record.session.model.id).toBe(outside.id);
    await h.manager.disposeRuntime(id);

    h.ctx.scopedModels = [{ model: inside }];
    // Queue-only mail must not try to reload the excluded selected model.
    await expect(
      h.call("send_message", { target: id, message: "queued info" }),
    ).resolves.toMatchObject({
      value: "",
    });
    expect(record.session).toBeUndefined();
    h.ctx.model = inside;
    await expect(h.call("followup_task", { target: id, message: "rejected work" })).rejects.toThrow(
      "Model not in scope",
    );
    expect(record.session).toBeUndefined();
    expect(record.generation).toBe(1);
    expect(h.faux.state.callCount).toBe(1);

    h.ctx.scopedModels = [];
    await h.call("followup_task", { target: id, message: "accepted work" });
    await h.manager.waitForAll();
    expect(record.session.model.id).toBe(outside.id);
    expect(JSON.stringify(record.session.messages)).toContain("queued info");
    expect(JSON.stringify(record.session.messages)).not.toContain("rejected work");
    expect(record.result).toBe("continued");
  },
);

it("tightens root scope without aborting a turn, and rejects later work even through old captures", async () => {
  const nativeSetter = AgentSession.prototype.setScopedModels;
  const h = await setupV2(cleanup);
  h.pi.getActiveTools = () => [
    "spawn_agent",
    "list_agents",
    "send_message",
    "followup_task",
    "wait_agent",
    "interrupt_agent",
  ];
  const outside = h.faux.getModel();
  const inside = { ...outside, id: "inside" };
  const provider = h.ctx.modelRegistry.getRegisteredProviderConfig(outside.provider);
  h.ctx.modelRegistry.getAvailable = () => [inside, outside];
  h.ctx.modelRegistry.getRegisteredProviderConfig = () => ({
    ...provider,
    models: [inside, outside],
  });
  const root = await openAgentSession(h.ctx, "default", {
    pi: h.pi,
    model: outside,
    isolated: true,
  });
  cleanup.unshift(() => shutdownAgentSession(root));
  h.ctx.sessionManager = root.sessionManager;
  await h.emit("session_start");
  h.faux.setResponses([
    {
      ...fauxAssistantMessage(""),
      stopReason: "toolUse",
      content: [
        { type: "toolCall", id: "wait", name: "wait_agent", arguments: { timeout_ms: 3_600_000 } },
      ],
    },
  ]);
  const spawned = await h.call("spawn_agent", {
    task_name: "a",
    message: "wait",
    fork_turns: "none",
  });
  const record = h.manager.getRecord(spawned.details.agentId);
  await vi.waitFor(() => expect(record.toolCalls).toHaveLength(1));
  const child = h.controller.forChild(h.pi, record, () => h.pi.getActiveTools());
  const childCtx = { ...h.ctx, scopedModels: [], sessionManager: record.session.sessionManager };
  const oldChild = child.capture(childCtx);
  const oldRoot = h.controller.capture(h.ctx, { forkContext: false });
  // Native /scoped-models uses this setter. No root lifecycle event follows it.
  root.setScopedModels([{ model: inside }]);
  const rootDescriptors = Object.getOwnPropertyDescriptors(h.ctx);
  for (const key of Object.keys(h.ctx))
    Object.defineProperty(h.ctx, key, {
      configurable: true,
      get() {
        throw new Error("stale root ctx");
      },
    });
  for (const key of Object.keys(childCtx))
    Object.defineProperty(childCtx, key, {
      get() {
        throw new Error("stale child ctx");
      },
    });
  expect(record.status).toBe("running");
  expect(record.abortController.signal.aborted).toBe(false);
  await expect(
    oldChild.execute(
      "spawn_agent",
      { task_name: "leaf", message: "no", fork_turns: "none" },
      {
        callerId: oldChild.callerId,
        callId: "leaf",
      },
    ),
  ).rejects.toThrow("Model not in scope");
  await expect(
    oldRoot.execute(
      "followup_task",
      { target: "a", message: "no" },
      {
        callerId: oldRoot.callerId,
        callId: "followup",
      },
    ),
  ).rejects.toThrow("Model not in scope");
  expect(record.generation).toBe(1);
  Object.defineProperties(h.ctx, rootDescriptors);
  // Subsequent fresh root contexts read the native session's newly resolved scope.
  h.ctx.scopedModels = root.scopedModels;

  await h.call("interrupt_agent", { target: "a" });
  await record.promise;
  await expect(h.call("followup_task", { target: "a", message: "still no" })).rejects.toThrow(
    "Model not in scope",
  );
  await h.manager.disposeRuntime(record.id);
  // Mail still queues for an unloaded, out-of-scope conversation, without a reload.
  await expect(
    h.call("send_message", { target: "a", message: "information" }),
  ).resolves.toMatchObject({ value: "" });
  expect(record.session).toBeUndefined();
  await expect(h.call("followup_task", { target: "a", message: "no reload" })).rejects.toThrow(
    "Model not in scope",
  );
  expect(record.session).toBeUndefined();
  h.controller.invalidate();
  expect(AgentSession.prototype.setScopedModels).toBe(nativeSetter);
});
