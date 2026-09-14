import { afterEach, expect, test, vi } from "vitest";
import { createEventBus, SessionManager } from "@earendil-works/pi-coding-agent";
import type { RegisterCollaboration } from "../subagents/subagent-context.js";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createSubagents } from "../subagents/index.js";
import { CODEX_V1_TOOL_NAMES } from "../subagents/codex-v1-contract.js";
import {
  mockCtx,
  mockSession,
  waitForCancellation,
} from "../subagents/test/helpers/agent-manager-mocks.js";
import registerCodeMode from "./index.js";
import { convertResponsesTools } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { getCodeModeHostPath } from "./code-mode/binary.js";

vi.mock("../subagents/agent-runner.js", async (original) => ({
  ...(await original<typeof import("../subagents/agent-runner.js")>()),
  runAgent: vi.fn(),
  openAgentSession: vi.fn(),
  resumeAgent: vi.fn(),
}));
import { runAgent, openAgentSession } from "../subagents/agent-runner.js";

let host: string | undefined;
try {
  host = getCodeModeHostPath();
} catch {
  /* Explicit dependency, never downloaded. */
}
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
  vi.restoreAllMocks();
});
async function setup(
  options: {
    adapter?: boolean;
    subagents?: boolean;
    selected?: string[];
    model?: string;
    sessionId?: string;
    collaboration?: RegisterCollaboration;
  } = {},
) {
  const handlers = new Map<string, Function[]>();
  const tools = new Map<string, any>();
  let active = ["custom", "read", "bash", "edit", "write"];
  const pi = {
    registerTool(tool: any) {
      tools.set(tool.name, tool);
      if (!active.includes(tool.name)) active.push(tool.name);
    },
    registerCommand: vi.fn(),
    registerMessageRenderer: vi.fn(),
    registerMarkdownTransformer: vi.fn(),
    on(name: string, handler: Function) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    events: createEventBus(),
    sendMessage: vi.fn(),
    appendEntry: vi.fn(),
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => {
      active = [...names];
    },
    getThinkingLevel: () => "high",
  } as any;
  const model = {
    provider: "test",
    id: options.model ?? "gpt-6",
    name: "GPT-6",
    input: ["text"],
    reasoning: true,
  };
  const sessionManager = SessionManager.inMemory("/tmp", {
    id: options.sessionId ?? "parent-session",
  });
  sessionManager.appendMessage({ role: "user", content: "remember this", timestamp: 1 });
  const ctx = {
    ...mockCtx,
    cwd: process.cwd(),
    sessionManager,
    model,
    scopedModels: [],
    modelRegistry: { ...mockCtx.modelRegistry, getAvailable: () => [model] },
    ui: { notify: vi.fn(), setWidget: vi.fn(), setStatus: vi.fn() },
    hasUI: false,
    isProjectTrusted: () => true,
    signal: new AbortController().signal,
  } as any;
  let adapter: ReturnType<typeof registerCodeMode> | undefined;
  const allowed = () => adapter?.getAllowedTools() ?? pi.getActiveTools();
  const controller =
    options.subagents === false
      ? undefined
      : options.collaboration
        ? options.collaboration(pi, allowed)
        : createSubagents(pi, undefined, undefined, undefined, allowed);
  controller?.registerTools();
  const config = { current: {} as import("../config.js").BitesConfig };
  if (options.adapter !== false) adapter = registerCodeMode(pi, config, undefined, controller);
  if (options.selected) pi.setActiveTools(options.selected);
  const emit = async (name: string, current = ctx) => {
    for (const handler of handlers.get(name) ?? [])
      await handler({ systemPrompt: "project", systemPromptOptions: {} }, current);
  };
  await emit("session_start");
  cleanups.push(() => emit("session_shutdown"));
  const exec = (code: string) => tools.get("exec").execute("outer", { code });
  const direct = (name: string, args: unknown) =>
    tools.get(name).execute(`direct-${name}`, args, undefined, undefined, ctx);
  return { controller, tools, pi, ctx, emit, exec, direct, config };
}
function values(result: any): any {
  expect(result.details.failed, result.details.errorText).toBe(false);
  return JSON.parse(result.details.output);
}
const native = test.skipIf(!host);

native(
  "native discovery and shared direct/nested operations preserve V1 payloads and reject errors",
  async () => {
    vi.mocked(runAgent).mockImplementation((_parent, _type, _prompt, options) =>
      waitForCancellation(options.signal),
    );
    const h = await setup();
    expect(h.pi.getActiveTools()).toEqual(["custom", "exec", "wait"]);
    const wire = () =>
      convertResponsesTools(
        h.pi
          .getActiveTools()
          .map((name: string) => h.tools.get(name))
          .filter(Boolean),
        { supportsOpenAIGrammarTools: true },
      );
    expect(wire().map((tool: any) => tool.name)).toEqual(["exec", "wait"]);
    const initialWire = wire();
    const discovery = await h.exec(
      'text(ALL_TOOLS.filter(t => t.name.startsWith("multi_agent_v1__")))',
    );
    const metadata = values(discovery);
    expect(metadata.map((t: any) => t.name)).toEqual(
      CODEX_V1_TOOL_NAMES.map((name) => `multi_agent_v1__${name}`),
    );
    expect(metadata.every((t: any) => t.description.includes("Promise<"))).toBe(true);
    expect(runAgent).not.toHaveBeenCalled();
    expect(wire()).toEqual(initialWire);
    const spawn = await h.exec('text(await tools.multi_agent_v1__spawn_agent({message:"nested"}))');
    const agent = values(spawn) as any;
    expect(agent).toEqual({ agent_id: expect.any(String), nickname: "nested" });
    expect(spawn.details.traces[0].name).toBe("multi_agent_v1__spawn_agent");
    const error = await h.exec(
      'await tools.multi_agent_v1__send_input({target:"missing",message:"hello"})',
    );
    expect(error.details.errorText).toContain("agent with id missing not found");
    await expect(h.direct("send_input", { target: "missing", message: "hello" })).rejects.toThrow(
      "agent with id missing not found",
    );
    const nestedClosed = values(
      await h.exec(
        `text(await tools.multi_agent_v1__close_agent({target:${JSON.stringify(agent.agent_id)}}))`,
      ),
    );
    const directAgent = await h.direct("spawn_agent", { message: "direct" });
    expect(nestedClosed).toEqual(
      (await h.direct("close_agent", { target: directAgent.value.agent_id })).value,
    );
    expect(JSON.stringify(spawn.content)).not.toContain('"details"');
    expect(
      values(await h.exec('text(ALL_TOOLS.filter(t => t.name.startsWith("multi_agent_v1__")))')),
    ).toEqual(metadata);
  },
);

native(
  "agent waits yield cells, cancellation retains agents, and exposure switches preserve identity",
  async () => {
    vi.mocked(runAgent).mockImplementation((_parent, _type, _prompt, options) =>
      waitForCancellation(options.signal),
    );
    const h = await setup();
    const agent: any = values(
      await h.exec(
        'text(await tools.multi_agent_v1__spawn_agent({message:"retained",fork_context:true}))',
      ),
    );
    const waiting = await h.exec(
      `// @exec: {"yield_time_ms": 0}\ntext(await tools.multi_agent_v1__wait_agent({targets:[${JSON.stringify(agent.agent_id)}]}))`,
    );
    expect(waiting.details.state).toBe("yielded");
    const ended = await h.tools
      .get("wait")
      .execute("outer-wait", { cell_id: waiting.details.cellId, terminate: true });
    expect(ended.details.state).toBe("terminated");
    h.ctx.model = { ...h.ctx.model, id: "gpt-5.6" };
    await h.emit("model_select");
    expect(
      values(
        await h.exec(
          `text(await tools.multi_agent_v1__send_input({target:${JSON.stringify(agent.agent_id)},message:"still here"}))`,
        ),
      ),
    ).toEqual({ submission_id: expect.any(String) });
    h.ctx.model = { ...h.ctx.model, id: "other" };
    await h.emit("model_select");
    expect(h.pi.getActiveTools()).toEqual(
      expect.arrayContaining([...CODEX_V1_TOOL_NAMES, "custom", "read"]),
    );
    expect(h.pi.getActiveTools()).not.toContain("exec");
    expect((await h.direct("close_agent", { target: agent.agent_id })).value).toEqual({
      previous_status: "running",
    });
  },
);

test("adapter and subagent disables and selected controls preserve standalone capability restrictions", async () => {
  const standalone = await setup({ adapter: false });
  expect(standalone.pi.getActiveTools()).toEqual(expect.arrayContaining([...CODEX_V1_TOOL_NAMES]));
  const disabled = await setup({ subagents: false });
  expect(disabled.pi.getActiveTools()).toEqual(["custom", "exec", "wait"]);
  const selected = await setup({ selected: ["custom", "spawn_agent", "close_agent", "exec"] });
  expect(selected.pi.getActiveTools()).toEqual(["custom", "spawn_agent", "close_agent", "exec"]);
  expect(selected.tools.get("exec").description).not.toContain("V1 collaboration is available");
});

native(
  "parallel calls use stable context snapshots and outer wait resumes an agent wait",
  async () => {
    vi.mocked(runAgent).mockImplementation((_parent, _type, prompt, options) => {
      const session = mockSession();
      session.sessionManager = SessionManager.inMemory("/tmp", { id: `child-${prompt}` });
      session.sessionManager.appendMessage({ role: "user", content: prompt, timestamp: 1 });
      options.onSessionCreated?.(session);
      return waitForCancellation(options.signal);
    });
    const h = await setup();
    const stable = { ...h.ctx };
    for (const key of Object.keys(h.ctx))
      Object.defineProperty(h.ctx, key, {
        configurable: true,
        get() {
          throw new Error(`stale ctx.${key}`);
        },
      });
    const agents = values(
      await h.exec(
        'text(await Promise.all(["one", "two"].map(message => tools.multi_agent_v1__spawn_agent({message}))))',
      ),
    );
    expect(new Set(agents.map((agent: any) => agent.agent_id)).size).toBe(2);
    const id = agents[0].agent_id;
    const waiting = await h.exec(
      `// @exec: {"yield_time_ms": 0}\ntext(await tools.multi_agent_v1__wait_agent({targets:[${JSON.stringify(id)}]}))`,
    );
    expect(waiting.details.state).toBe("yielded");
    await h.exec(`await tools.multi_agent_v1__close_agent({target:${JSON.stringify(id)}})`);
    const result = await h.tools.get("wait").execute("wait", { cell_id: waiting.details.cellId });
    expect(values(result)).toEqual({ status: { [id]: "shutdown" }, timed_out: false });
    vi.mocked(openAgentSession).mockResolvedValueOnce(mockSession());
    expect(
      values(
        await h.exec(`text(await tools.multi_agent_v1__resume_agent({id:${JSON.stringify(id)}}))`),
      ),
    ).toEqual({ status: "pending_init" });
    expect(
      values(
        await h.exec(
          `text(await tools.multi_agent_v1__send_input({target:${JSON.stringify(id)},message:"again"}))`,
        ),
      ),
    ).toEqual({ submission_id: expect.any(String) });
    await h.exec(`await tools.multi_agent_v1__close_agent({target:${JSON.stringify(id)}})`);
    for (const [key, value] of Object.entries(stable))
      Object.defineProperty(h.ctx, key, { configurable: true, writable: true, value });
  },
);

native.each(["disable", "selection", "owner"])(
  "previously discovered functions reject after %s changes",
  async (change) => {
    vi.mocked(runAgent).mockImplementation((_parent, _type, _prompt, options) =>
      waitForCancellation(options.signal),
    );
    const h = await setup();
    const agent = values(
      await h.exec('text(await tools.multi_agent_v1__spawn_agent({message:"first"}))'),
    );
    const waiting = await h.exec(
      `// @exec: {"yield_time_ms": 0}\ntry { await tools.multi_agent_v1__wait_agent({targets:[${JSON.stringify(agent.agent_id)}]}); } catch {} text(await tools.multi_agent_v1__spawn_agent({message:"forbidden"}));`,
    );
    expect(waiting.details.state).toBe("yielded");
    if (change === "disable") h.config.current.disable = ["subagents"];
    else if (change === "selection")
      h.pi.setActiveTools(h.pi.getActiveTools().filter((name: string) => name !== "wait"));
    else h.controller!.invalidate();
    await h.direct("close_agent", { target: agent.agent_id });
    const result = await h.tools.get("wait").execute("wait", { cell_id: waiting.details.cellId });
    expect(result.details.failed).toBe(true);
    expect(result.details.errorText).toMatch(/unavailable|owner changed/);
    expect(vi.mocked(runAgent).mock.calls.filter((call) => call[2] === "forbidden")).toHaveLength(
      0,
    );
  },
);

native(
  "children choose their own model surface without gaining unselected operations",
  async () => {
    vi.mocked(runAgent).mockImplementation((_parent, _type, _prompt, options) =>
      waitForCancellation(options.signal),
    );
    const parent = await setup({
      selected: ["custom", "spawn_agent", "send_input", "exec", "wait"],
    });
    const agent = values(
      await parent.exec('text(await tools.multi_agent_v1__spawn_agent({message:"child"}))'),
    );
    const options = vi.mocked(runAgent).mock.calls.at(-1)![3];
    const child = await setup({
      model: "other",
      sessionId: "child-session",
      collaboration: options.registerCollaboration,
      selected: options.allowedTools,
    });
    options.onSessionCreated?.({ ...mockSession(), sessionManager: child.ctx.sessionManager });
    expect(child.pi.getActiveTools()).toEqual(["custom", "spawn_agent", "send_input"]);
    expect(
      (await child.direct("send_input", { target: "parent-session", message: "hello parent" }))
        .value,
    ).toEqual({ submission_id: expect.any(String) });
    child.ctx.model = { ...child.ctx.model, id: "gpt-6" };
    await child.emit("model_select");
    expect(child.pi.getActiveTools()).toEqual(["custom", "exec", "wait"]);
    const tools = values(await child.exec("text(ALL_TOOLS)"));
    expect(tools.map((tool: any) => tool.name)).toEqual([
      "multi_agent_v1__spawn_agent",
      "multi_agent_v1__send_input",
    ]);
    expect(
      values(
        await child.exec(
          'text(await tools.multi_agent_v1__send_input({target:"parent-session", message:"nested parent"}))',
        ),
      ),
    ).toEqual({ submission_id: expect.any(String) });
    expect(parent.pi.sendMessage).toHaveBeenCalled();
    expect(agent.agent_id).toEqual(expect.any(String));
  },
);

native(
  "nested and restored collaboration reuses semantic renderers without exposing source",
  async () => {
    const h = await setup();
    const result = await h.exec(
      'await tools.multi_agent_v1__send_input({target:"missing",message:"hello"})',
    );
    const tool = h.tools.get("exec");
    const plain = {
      bold: (text: string) => text,
      fg: (_role: string, text: string) => text,
      bg: (_role: string, text: string) => text,
    };
    for (const expanded of [false, true])
      for (const restored of [false, true]) {
        const context = {
          args: { code: "hidden source" },
          toolCallId: "render",
          state: {},
          cwd: process.cwd(),
          executionStarted: true,
          argsComplete: true,
          isPartial: false,
          isError: true,
          expanded,
          showImages: false,
          invalidate() {},
        };
        const saved = restored ? JSON.parse(JSON.stringify(result)) : result;
        const body = tool.renderResult(saved, { expanded, isPartial: false }, plain, context);
        const lines = body.render(60);
        expect(lines.every((line: string) => visibleWidth(line) <= 60)).toBe(true);
        const text = lines.join("\n");
        expect(text).toContain("send_input → missing");
        expect(text).toContain("agent with id missing not found");
        expect(text).not.toContain("hidden source");
        expect(lines[0].trim()).toBe("");
        expect(lines.at(-1).trim()).toBe("");
      }
    const styled = {
      bold: (text: string) => `<bold>${text}</bold>`,
      fg: (role: string, text: string) => `<${role}>${text}</${role}>`,
      bg: (_role: string, text: string) => text,
    };
    const body = tool.renderResult(result, { expanded: false, isPartial: false }, styled, {
      args: {},
      state: {},
      expanded: false,
      isError: true,
      invalidate() {},
    });
    expect(body.render(300).join("\n")).toContain("<bold>send_input</bold><accent>");
  },
);

test("missing hosts fail visibly without exposing standalone agents", async () => {
  const h = await setup();
  vi.stubEnv("PATH", "");
  try {
    await expect(
      h.exec('await tools.multi_agent_v1__spawn_agent({message:"never"})'),
    ).rejects.toThrow("was not found executable on PATH");
    expect(h.pi.getActiveTools()).toEqual(["custom", "exec", "wait"]);
    expect(vi.mocked(runAgent).mock.calls.filter((call) => call[2] === "never")).toHaveLength(0);
  } finally {
    vi.unstubAllEnvs();
  }
});
