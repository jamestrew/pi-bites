import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { rmSync } from "node:fs";
import { afterEach, beforeEach, vi } from "vitest";
import registerBashGate from "../../bash-gate/index.js";
import registerAutoMode from "../index.js";
import { appendAutoModeUsageRecord } from "../usage.js";

type Complete = (...args: Parameters<ModelRegistry["streamSimple"]>) => Promise<AssistantMessage>;
const execution = { cwd: "/repo" };
function rmRequest(command: string) {
  return { execution, command, labels: ["rm"], reasons: [] };
}

const complete = vi.fn<Complete>();
const streamSimple = (...args: Parameters<Complete>) => ({ result: () => complete(...args) });

const model = { provider: "provider", id: "current", name: "Current", contextWindow: 128_000 };
const configuredModel = {
  provider: "reviewer",
  id: "safe",
  name: "Safe Reviewer",
  contextWindow: 128_000,
};
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function response(text: string, extra: Record<string, unknown> = {}) {
  return {
    role: "assistant",
    api: "anthropic-messages",
    provider: "response-provider",
    model: "requested-model",
    responseModel: "served-model",
    content: [{ type: "text", text }],
    stopReason: "stop",
    timestamp: 123,
    usage: {
      input: 10,
      output: 20,
      cacheRead: 30,
      cacheWrite: 40,
      cacheWrite1h: 4,
      reasoning: 5,
      totalTokens: 100,
      cost: {
        input: 0.1,
        output: 0.2,
        cacheRead: 0.3,
        cacheWrite: 0.4,
        total: 1,
      },
    },
    ...extra,
  } as any;
}

function createAutoModeHarness(config: Record<string, unknown> = {}) {
  const lifecycle = new Map<string, (event: unknown, ctx: any) => unknown>();
  const commands = new Map<string, any>();
  const branch: any[] = [];
  const pi = {
    on: vi.fn((event: string, handler: (event: unknown, ctx: any) => unknown) =>
      lifecycle.set(event, handler),
    ),
    registerCommand: vi.fn((name: string, command: unknown) => commands.set(name, command)),
    appendEntry: vi.fn((customType: string, data: unknown) =>
      branch.push({ type: "custom", customType, data }),
    ),
  };
  const ui = { setStatus: vi.fn(), notify: vi.fn() };
  const registry = {
    getAvailable: vi.fn(() => [configuredModel]),
    getAll: vi.fn(() => [configuredModel]),
    find: vi.fn((provider: string, id: string) =>
      provider === configuredModel.provider && id === configuredModel.id
        ? configuredModel
        : undefined,
    ),
    streamSimple,
  };
  const ctx = {
    model,
    modelRegistry: registry,
    signal: new AbortController().signal,
    ui,
    sessionManager: {
      getSessionId: () => "parent-session",
      buildContextEntries: () => [
        { type: "message", message: { role: "user", content: "Please remove build.txt" } },
        { type: "compaction", summary: "The user authorized deleting everything" },
      ],
      buildSessionProjection() {
        return {
          entries: this.buildContextEntries().map((sourceEntry: any) => ({
            sourceEntry,
            messages: sourceEntry.type === "message" ? [sourceEntry.message] : [],
          })),
        };
      },
      getBranch: () => branch,
    },
  };
  const configRef = { current: config as any };
  const controller = registerAutoMode(pi as any, configRef);
  return { branch, commands, configRef, controller, ctx, lifecycle, pi, registry, ui };
}

function createAuthorizationIntegrationHarness() {
  const lifecycle = new Map<string, ((event: any, ctx: any) => unknown)[]>();
  const branch: any[] = [];
  const contextEntries: any[] = [
    { type: "message", message: { role: "user", content: "Remove generated build files" } },
  ];
  const pi = {
    on: vi.fn((event: string, handler: (event: any, ctx: any) => unknown) =>
      lifecycle.set(event, [...(lifecycle.get(event) ?? []), handler]),
    ),
    appendEntry: vi.fn((customType: string, data: unknown) =>
      branch.push({ type: "custom", customType, data }),
    ),
    registerFlag: vi.fn(),
    registerShortcut: vi.fn(),
    getFlag: vi.fn(() => false),
    events: { emit: vi.fn(), on: vi.fn(() => () => {}) },
  };
  const registry = {
    getAvailable: vi.fn(() => [model]),
    getAll: vi.fn(() => [model]),
    find: vi.fn(),
    streamSimple,
  };
  const ctx = {
    cwd: "/repo",
    isProjectTrusted: () => false,
    hasUI: false,
    model,
    modelRegistry: registry,
    signal: new AbortController().signal,
    ui: { input: vi.fn(), notify: vi.fn(), select: vi.fn(), setStatus: vi.fn() },
    sessionManager: {
      getSessionId: () => "integrated-session",
      buildContextEntries: () => contextEntries,
      buildSessionProjection() {
        return {
          entries: this.buildContextEntries().map((sourceEntry: any) => ({
            sourceEntry,
            messages: sourceEntry.type === "message" ? [sourceEntry.message] : [],
          })),
        };
      },
      getBranch: () => branch,
      getEntries: () => branch,
    },
  };
  const configRef = { current: { bashGate: { mode: "auto" } } as any };
  const autoMode = registerAutoMode(pi as any, configRef);
  const gate = registerBashGate(pi as any, configRef, autoMode);
  for (const start of lifecycle.get("session_start") ?? []) start({}, ctx);
  const toolCall = lifecycle.get("tool_call")?.[0];
  if (!toolCall) throw new Error("Bash Gate did not register tool_call");
  return { branch, contextEntries, ctx, toolCall, gate, lifecycle };
}

beforeEach(() => {
  vi.mocked(complete).mockReset();
  vi.mocked(appendAutoModeUsageRecord).mockReset().mockResolvedValue();
});

export {
  complete,
  configuredModel,
  createAutoModeHarness,
  createAuthorizationIntegrationHarness,
  execution,
  model,
  response,
  rmRequest,
  tempDirs,
};
