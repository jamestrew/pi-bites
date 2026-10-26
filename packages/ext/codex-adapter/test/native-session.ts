import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, vi } from "vitest";
import {
  InMemoryCredentialStore,
  createAssistantMessageEventStream,
  getCurrentTools,
  type AssistantMessage,
  type StreamFunction,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createToolSearchExtension,
  type ExtensionContext,
  type ExtensionUIContext,
  type FileEntry,
  type ToolDefinition,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import registerAdapter from "../index.js";
import registerBashGate from "../../bash-gate/index.js";
import type { CommandAuthorizationRequest, BashGateController } from "../../bash-gate/index.js";
import type { BitesConfig } from "../../config.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
function response(
  model: Parameters<StreamFunction>[0],
  content: AssistantMessage["content"],
  stopReason: "stop" | "toolUse",
) {
  const stream = createAssistantMessageEventStream();
  const message: AssistantMessage = {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  };
  queueMicrotask(() => {
    stream.push({ type: "done", reason: stopReason, message });
    stream.end(message);
  });
  return stream;
}
export async function setup(
  selected?: string[],
  options: {
    model?: string;
    config?: BitesConfig;
    defaultTools?: string[];
    excludeTools?: string[];
    noTools?: "all" | "builtin";
    persist?: boolean;
    sessionFile?: string;
    entries?: FileEntry[];
    extensionTools?: ToolDefinition[];
    gate?: boolean;
    onAuthorization?: (request: CommandAuthorizationRequest) => void;
  } = {},
) {
  const config = { current: options.config ?? {} };
  const ui = {
    select: vi.fn(async () => "Allow" as string | undefined),
    notify: vi.fn(),
    setStatus: vi.fn(),
    input: vi.fn(),
  };
  let captured: ExtensionContext | undefined;
  let setTools: (names: string[]) => void;
  let adapter: ReturnType<typeof registerAdapter>;
  let preview: ReturnType<typeof registerAdapter>["previewPrompt"] | undefined;
  let transform: ((text: string, ctx: any) => string) | undefined;
  const saved = options.sessionFile ? SessionManager.open(options.sessionFile) : undefined;
  const cwd = saved?.getCwd() ?? mkdtempSync(join(tmpdir(), "native-adapter-"));
  const runtime = await ModelRuntime.create({
    allowModelNetwork: false,
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
  });
  runtime.registerProvider("native-test", {
    api: "openai-responses",
    apiKey: "test",
    authHeader: true,
    baseUrl: "http://localhost",
    models: ["gpt-6.1-sol", "claude"].map((id) => ({
      id,
      name: id,
      reasoning: false,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 100,
    })),
  });
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: cwd,
    noExtensions: true,
    noSkills: true,
    noContextFiles: true,
    extensionFactories: [
      createToolSearchExtension(),
      (pi) => {
        for (const tool of options.extensionTools ?? []) pi.registerTool(tool);
        setTools = pi.setActiveTools;
        const gate: BashGateController | undefined = options.onAuthorization
          ? {
              manageExecCommand() {},
              isYolo: () => false,
              captureSession: () => ({
                async authorize(request, launch) {
                  options.onAuthorization!(request);
                  return await launch();
                },
              }),
            }
          : options.gate
            ? registerBashGate(pi, config)
            : undefined;
        const original = pi.registerMarkdownTransformer;
        adapter = registerAdapter(
          {
            ...pi,
            registerMarkdownTransformer: (fn) => {
              transform = fn;
              original(fn);
            },
          },
          config,
          gate,
          { tools: selected, noTools: options.noTools },
        );
        preview = adapter.previewPrompt;
        pi.on("session_start", (_e, ctx) => {
          captured = ctx;
        });
      },
    ],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd,
    agentDir: cwd,
    modelRuntime: runtime,
    model: runtime.getModel("native-test", options.model ?? "gpt-6.1-sol")!,
    resourceLoader: loader,
    sessionManager:
      saved ??
      (options.persist
        ? SessionManager.create(cwd, join(cwd, "sessions"))
        : SessionManager.inMemory(cwd, {}, options.entries)),
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
      ...(options.defaultTools ? { defaultTools: options.defaultTools } : {}),
    }),
    ...(selected ? { tools: selected } : {}),
    ...(options.excludeTools ? { excludeTools: options.excludeTools } : {}),
    ...(options.noTools ? { noTools: options.noTools } : {}),
  });
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  }
  cleanup.push(async () => {
    await close();
    if (!saved) rmSync(cwd, { recursive: true, force: true });
  });
  await session.bindExtensions(
    options.gate ? { uiContext: ui as unknown as ExtensionUIContext } : {},
  );
  const events: any[] = [];
  session.subscribe((event) => events.push(event));
  let seq = 0;
  const declarations: string[][] = [];
  async function call(name: string, args: import("@earendil-works/pi-ai").JsonObject) {
    const id = `script-${++seq}`;
    let turns = 0;
    session.agent.streamFunction = (model, context) => {
      declarations.push(getCurrentTools(context.messages).map((tool) => tool.name));
      return turns++ === 0
        ? response(model, [{ type: "toolCall", id, name, arguments: args }], "toolUse")
        : response(model, [{ type: "text", text: "done" }], "stop");
    };
    await session.prompt("run");
    const end = events.find((e) => e.type === "tool_execution_end" && e.toolCallId === id);
    expect(end).toBeDefined();
    return end;
  }
  const run = (code: string) => call("codemode", { code });
  return {
    session,
    close,
    run,
    call,
    events,
    declarations,
    cwd,
    runtime,
    config,
    ui,
    setTools: (names: string[]) => setTools(names),
    getContext: () => captured!,
    preview: () => preview!,
    previewTools: () => adapter.previewTools!(session.getAllTools()),
    transform: (text: string) => transform!(text, { messageType: "assistant" }),
  };
}
export const textOf = (event: any) =>
  event.result.content
    .filter((c: any) => c.type === "text")
    .map((c: any) => c.text)
    .join("\n");
