import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getApiProvider, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { vi } from "vitest";
import { createEventBus, SessionManager } from "@earendil-works/pi-coding-agent";
import registerSubagents from "../../index.js";
import { mockCtx } from "./agent-manager-mocks.js";

export function harness(
  cleanup: (() => Promise<unknown>)[],
  autoMode?: Parameters<typeof registerSubagents>[1],
) {
  const handlers = new Map<string, Function[]>();
  const direct = new Map<string, any>();
  const pi = {
    registerTool: (tool: any) => direct.set(tool.name, tool),
    registerCommand: vi.fn(),
    registerMessageRenderer: vi.fn(),
    on: (name: string, fn: Function) => handlers.set(name, [...(handlers.get(name) ?? []), fn]),
    events: createEventBus(),
    sendMessage: vi.fn(),
    appendEntry: vi.fn(),
    getActiveTools: () => ["spawn_agent", "list_agents", "read"],
    getThinkingLevel: () => "high",
  } as any;
  const sessionManager = SessionManager.inMemory("/tmp", { id: "root-session" });
  sessionManager.appendMessage({ role: "user", content: "remember", timestamp: 1 });
  const ctx = {
    ...mockCtx,
    sessionManager,
    scopedModels: [],
    hasUI: false,
    ui: { notify: vi.fn(), setWidget: vi.fn(), setStatus: vi.fn() },
  } as any;
  const controller = registerSubagents(pi, autoMode);
  const emit = async (event: string, payload: unknown = {}) => {
    for (const fn of handlers.get(event) ?? []) await fn(payload, ctx);
  };
  cleanup.push(() => emit("session_shutdown"));
  const call = (name: string, args: unknown, signal?: AbortSignal) =>
    direct.get(name).execute(crypto.randomUUID(), args, signal, undefined, ctx);
  return { pi, ctx, controller, direct, call, emit };
}

export async function setupV2(
  cleanup: (() => Promise<unknown>)[],
  autoMode?: Parameters<typeof harness>[1],
) {
  const cwd = mkdtempSync(join(tmpdir(), "v2-mail-"));
  const faux = registerFauxProvider({
    provider: "v2-mail",
    models: [{ id: "test-model", contextWindow: 200_000 }],
  });
  const model = faux.getModel();
  const h = harness(cleanup, autoMode);
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
