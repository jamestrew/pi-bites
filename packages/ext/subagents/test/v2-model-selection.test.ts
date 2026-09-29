import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
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
    join(h.ctx.cwd, ".pi/subagents.json"),
    JSON.stringify({ defaultModel: "test-model" }),
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
    join(h.ctx.cwd, ".pi/subagents.json"),
    JSON.stringify({ defaultReasoningEffort: "low" }),
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
    join(h.ctx.cwd, ".pi/subagents.json"),
    JSON.stringify({ defaultModel: "parent", defaultReasoningEffort: "high" }),
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
    join(h.ctx.cwd, ".pi/subagents.json"),
    JSON.stringify({ defaultModel: "missing/model" }),
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
