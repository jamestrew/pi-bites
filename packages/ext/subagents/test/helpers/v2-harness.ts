import { vi } from "vitest";
import { createEventBus, SessionManager } from "@earendil-works/pi-coding-agent";
import { createV2IntegrationHarness } from "../../v2-integration-harness.js";
import { mockCtx } from "./agent-manager-mocks.js";

export function harness(cleanup: (() => Promise<unknown>)[]) {
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
  const controller = createV2IntegrationHarness(pi);
  const emit = async (event: string, payload: unknown = {}) => {
    for (const fn of handlers.get(event) ?? []) await fn(payload, ctx);
  };
  cleanup.push(() => emit("session_shutdown"));
  const call = (name: string, args: unknown, signal?: AbortSignal) =>
    direct.get(name).execute(crypto.randomUUID(), args, signal, undefined, ctx);
  return { pi, ctx, controller, direct, call, emit };
}
