/** Real Pi registration/children and stock provider payload construction, stopped before transport. */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { stream } from "@earendil-works/pi-ai/compat";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import { createSubagents } from "../index.js";
import registerAdapter from "../../codex-adapter/index.js";
import { EXTENSION_NAMES, type BitesConfig } from "../../config.js";
import type { SubagentController } from "../operations.js";

vi.setConfig({ testTimeout: 30_000 });
const collaboration = [
  "followup_task",
  "interrupt_agent",
  "list_agents",
  "send_message",
  "spawn_agent",
  "wait_agent",
];
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function setup({
  route,
  disabled = false,
  selected,
  subagentsDisabled = false,
}: {
  route: "gpt" | "anthropic" | "older-gpt";
  disabled?: boolean;
  selected?: string[];
  subagentsDisabled?: boolean;
}) {
  const cwd = mkdtempSync(join(tmpdir(), "v2-exposure-"));
  cleanup.push(async () => rmSync(cwd, { recursive: true, force: true }));
  const config: { current: BitesConfig } = {
    current: {
      disable: EXTENSION_NAMES.filter(
        (name) =>
          ![
            ...(subagentsDisabled ? [] : ["subagents"]),
            ...(disabled ? [] : ["codexAdapter"]),
          ].includes(name),
      ),
    },
  };
  mkdirSync(join(cwd, ".pi"));
  writeFileSync(join(cwd, ".pi", "pi-bites.json"), JSON.stringify(config.current));
  const runtime = await ModelRuntime.create({
    allowModelNetwork: false,
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
  });
  const payloads: any[] = [];
  const fetch = vi.fn(async () => {
    throw new Error("unexpected transport");
  });
  for (const [provider, api, ids] of [
    ["cutover-openai", "openai-responses", ["gpt-6", "gpt-4.1"]],
    ["cutover-anthropic", "anthropic-messages", ["claude-sonnet-4-5"]],
  ] as const) {
    runtime.registerProvider(provider, {
      api,
      apiKey: "fixture-only",
      baseUrl: "http://localhost",
      models: ids.map((id) => ({
        id,
        name: id,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 128,
      })),
      streamSimple(model, context, options) {
        return stream(model, context, {
          ...options,
          apiKey: "fixture-only",
          fetch: fetch as unknown as typeof globalThis.fetch,
          async onPayload(payload, requestModel) {
            const next = await options?.onPayload?.(payload, requestModel);
            payloads.push(structuredClone(next ?? payload));
            throw new Error("payload captured before transport");
          },
        });
      },
    });
  }
  const gpt = runtime.getModel("cutover-openai", "gpt-6")!;
  const anthropic = runtime.getModel("cutover-anthropic", "claude-sonnet-4-5")!;
  const model =
    route === "anthropic"
      ? anthropic
      : route === "older-gpt"
        ? runtime.getModel("cutover-openai", "gpt-4.1")!
        : gpt;
  let operation!: ReturnType<SubagentController["capture"]>;
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: cwd,
    noExtensions: true,
    noSkills: true,
    noContextFiles: true,
    noPromptTemplates: true,
    noThemes: true,
    extensionFactories: [
      (pi) => {
        let adapter: ReturnType<typeof registerAdapter> | undefined;
        const controller = subagentsDisabled
          ? undefined
          : createSubagents(
              pi,
              undefined,
              undefined,
              undefined,
              () => adapter?.getAllowedTools() ?? pi.getActiveTools(),
            );
        controller?.registerTools();
        if (!disabled) adapter = registerAdapter(pi, config);
        pi.on("session_start", (_event, ctx) => {
          if (controller) operation = controller.capture(ctx);
        });
        pi.on("model_select", (_event, ctx) => {
          if (controller) operation = controller.capture(ctx);
        });
      },
    ],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd,
    agentDir: cwd,
    modelRuntime: runtime,
    model,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    }),
    ...(selected ? { tools: selected } : {}),
  });
  cleanup.push(async () => {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  });
  await session.bindExtensions({});
  const manager = Reflect.get(globalThis, Symbol.for("pi-subagents:manager"));
  const call = (name: Parameters<typeof operation.execute>[0], args: unknown) =>
    operation.execute(name, args, {
      callerId: operation.callerId,
      callId: crypto.randomUUID(),
    });
  return { session, call, manager, payloads, fetch, gpt, anthropic };
}

function assertPayload(payload: any, permitted: string[]) {
  expect(payload).toBeDefined();
  const tools = payload.tools ?? [];
  const names = tools.map((t: any) => t.name ?? t.function?.name);
  expect(names.filter((name: string) => collaboration.includes(name)).sort()).toEqual(
    [...permitted].sort(),
  );
  expect(new Set(names).size).toBe(names.length);
  for (const obsolete of [
    "send_input",
    "close_agent",
    "resume_agent",
    "multi_agent_v1__",
    "tool_search",
  ])
    expect(JSON.stringify(tools)).not.toContain(obsolete);
  expect(JSON.stringify(tools)).not.toContain("Before using collaboration");
  if (permitted.includes("spawn_agent")) {
    const spawn = tools.find((tool: any) => tool.name === "spawn_agent");
    expect((spawn.parameters ?? spawn.input_schema).required).toEqual(["task_name", "message"]);
  }
}

it.each([
  { route: "gpt" as const },
  { route: "gpt" as const, disabled: true },
  { route: "anthropic" as const },
  { route: "older-gpt" as const },
  {
    route: "gpt" as const,
    selected: ["spawn_agent", "send_message", "list_agents", "read", "codemode"],
  },
  { route: "anthropic" as const, selected: ["spawn_agent", "send_message", "list_agents", "read"] },
  { route: "gpt" as const, disabled: true, selected: ["spawn_agent", "list_agents", "read"] },
])("keeps permitted collaboration direct on parent/child payloads: %j", async (options) => {
  const h = await setup(options);
  const permitted = options.selected
    ? collaboration.filter((name) => options.selected!.includes(name))
    : collaboration;
  await h.session.prompt("Inspect the permitted tools.");
  expect(h.payloads.length, JSON.stringify(h.session.messages)).toBeGreaterThan(0);
  assertPayload(h.payloads.at(-1), permitted);
  const codeMode = options.route === "gpt" && !options.disabled;
  expect(h.session.getActiveToolNames().includes("codemode")).toBe(codeMode);
  const spawn = await h.call("spawn_agent", {
    task_name: "probe",
    message: "Inspect the permitted tools.",
    fork_turns: "none",
  });
  expect(spawn.value).toEqual({ task_name: "/root/probe" });
  await h.manager.waitForAll();
  expect(h.payloads).toHaveLength(2);
  assertPayload(h.payloads.at(-1), permitted);
  const childPayload = JSON.stringify(h.payloads.at(-1));
  expect(childPayload).toContain("Your parent task_name is /root.");
  expect(h.fetch).not.toHaveBeenCalled();
  // Opt-in synthetic evidence for release audits; never sends a provider request.
  const evidenceDir = process.env.SUBAGENTS_PAYLOAD_DIR;
  if (evidenceDir) {
    mkdirSync(evidenceDir, { recursive: true });
    const size = (value: unknown) => JSON.stringify(value ?? null).length;
    const evidence = h.payloads.map((payload, index) => ({
      owner: index === 0 ? "parent" : "child",
      characters: {
        payload: size(payload),
        tools: size(payload.tools),
        collaboration: size(payload.tools.filter((tool: any) => collaboration.includes(tool.name))),
        instructions: size(
          payload.instructions ??
            payload.system ??
            (payload.input ?? []).filter((item: any) =>
              ["system", "developer"].includes(item.role),
            ),
        ),
        history: size(
          (payload.input ?? payload.messages).filter(
            (item: any) => !["system", "developer"].includes(item.role),
          ),
        ),
      },
      payload,
    }));
    const name = `${options.route}-${options.disabled ? "disabled" : "enabled"}-${options.selected ? "selected" : "all"}`;
    writeFileSync(join(evidenceDir, `${name}.json`), JSON.stringify(evidence, null, 2) + "\n");
  }
});

it("preserves child ownership, tool restrictions and controls across provider switches", async () => {
  const h = await setup({
    route: "gpt",
    selected: ["spawn_agent", "send_message", "followup_task", "list_agents", "read", "codemode"],
  });
  await h.call("spawn_agent", {
    task_name: "probe",
    message: "inspect",
    fork_turns: "none",
    model: "cutover-anthropic/claude-sonnet-4-5",
  });
  await h.manager.waitForAll();
  assertPayload(h.payloads.at(-1), ["spawn_agent", "send_message", "followup_task", "list_agents"]);
  await h.session.setModel(h.anthropic);
  await h.session.prompt("Inspect the permitted tools after switching.");
  assertPayload(h.payloads.at(-1), ["spawn_agent", "send_message", "followup_task", "list_agents"]);
  expect((await h.call("list_agents", {})).value).toMatchObject({
    agents: expect.arrayContaining([expect.objectContaining({ agent_name: "/root/probe" })]),
  });
  await h.call("followup_task", { target: "/root/probe", message: "inspect again" });
  await h.manager.waitForAll();
  assertPayload(h.payloads.at(-1), ["spawn_agent", "send_message", "followup_task", "list_agents"]);
  await h.session.setModel(h.gpt);
  expect(h.session.getActiveToolNames()).toContain("codemode");
  expect(h.session.getActiveToolNames()).not.toContain("interrupt_agent");
  expect(h.fetch).not.toHaveBeenCalled();
});

it("disabling subagents leaves unrelated Code Mode tools available", async () => {
  const h = await setup({ route: "gpt", subagentsDisabled: true });
  await h.session.prompt("Inspect tools.");
  assertPayload(h.payloads.at(-1), []);
  expect(h.session.getActiveToolNames()).toContain("codemode");
  expect(JSON.stringify(h.payloads.at(-1).tools)).toContain("exec_command");
  expect(h.fetch).not.toHaveBeenCalled();
});

it.each([false, true])(
  "native parent payload uses stock grammar=%s without exec/wait or nested collaboration",
  async (grammar) => {
    const h = await setup({ route: "gpt" });
    h.gpt.compat = { ...h.gpt.compat, supportsOpenAIGrammarTools: grammar };
    await h.session.setModel(h.gpt);
    await h.session.prompt("Inspect native tools.");
    const payload = h.payloads.at(-1);
    const names = payload.tools.map((t: any) => t.name);
    expect(names).toContain("codemode");
    expect(names).not.toContain("exec");
    expect(names).not.toContain("wait");
    expect(names).not.toContain("exec_command");
    const codemode = payload.tools.find((t: any) => t.name === "codemode");
    expect(codemode.type).toBe(grammar ? "custom" : "function");
    if (grammar) expect(codemode.format).toMatchObject({ type: "grammar", syntax: "lark" });
    else expect(codemode.parameters.required).toEqual(["code"]);
    const callable = h.session.getCallableToolNames();
    for (const name of collaboration) expect(callable).not.toContain(name);
    assertPayload(payload, collaboration);
    expect(h.fetch).not.toHaveBeenCalled();
  },
);
