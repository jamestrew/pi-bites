import { beforeEach, afterEach, expect, test, vi } from "vitest";
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
import registerBashGate from "../bash-gate/index.js";
import registerCodeMode from "./index.js";
import { convertResponsesTools } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { getCodeModeHostPath } from "./code-mode/binary.js";

vi.mock("../subagents/agent-runner.js", async (original) => ({
  ...(await original<typeof import("../subagents/agent-runner.js")>()),
  runAgent: vi.fn(),
  openAgentSession: vi.fn(),
  resumeAgent: vi.fn(),
}));
import { runAgent, openAgentSession, resumeAgent } from "../subagents/agent-runner.js";

let host: string | undefined;
try {
  host = getCodeModeHostPath();
} catch {
  /* Explicit dependency, never downloaded. */
}
beforeEach(() => vi.clearAllMocks());
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
    autoMode?: Parameters<typeof createSubagents>[1];
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
        : createSubagents(pi, options.autoMode, undefined, undefined, allowed);
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

native(
  "all five child traces restore without live agents and move from exec to wait once",
  async () => {
    vi.mocked(runAgent).mockImplementation((_parent, _type, prompt, options) => {
      const session = mockSession();
      session.sessionManager = SessionManager.inMemory("/tmp", { id: "render-child" });
      session.sessionManager.appendMessage({ role: "user", content: prompt, timestamp: 1 });
      options.onSessionCreated?.(session);
      return waitForCancellation(options.signal);
    });
    const h = await setup();
    const spawned = await h.exec(
      'text(await tools.multi_agent_v1__spawn_agent({message:"recognizable child"}))',
    );
    const id = values(spawned).agent_id;
    const sent = await h.exec(
      `await tools.multi_agent_v1__send_input({target:"${id}",message:"one\\ntwo\\nthree\\nfour\\nfive\\nsix\\nseven\\neight\\nnine\\nten\\neleven"})`,
    );
    const waiting = await h.exec(
      `// @exec: {"yield_time_ms": 0}\ntext(await tools.multi_agent_v1__wait_agent({targets:["${id}"]}))`,
    );
    const closed = await h.exec(`await tools.multi_agent_v1__close_agent({target:"${id}"})`);
    const waited = await h.tools
      .get("wait")
      .execute("wait-render", { cell_id: waiting.details.cellId });
    vi.mocked(openAgentSession).mockResolvedValueOnce(mockSession());
    const resumed = await h.exec(`await tools.multi_agent_v1__resume_agent({id:"${id}"})`);
    const saved = JSON.parse(JSON.stringify([spawned, sent, closed, resumed, waiting, waited]));
    await h.emit("session_tree"); // Display data cannot reopen the closed agents.
    const fresh = await setup();
    const plain = {
      bold: (s: string) => s,
      fg: (_: string, s: string) => s,
      bg: (_: string, s: string) => s,
    };
    for (const expanded of [false, true]) {
      const components = saved.map((result: any, i: number) => {
        const tool = fresh.tools.get(i === 5 ? "wait" : "exec");
        const context = {
          state: {},
          expanded,
          isError: false,
          showImages: false,
          args: { code: "hidden JavaScript" },
          invalidate() {},
        };
        return tool.renderResult(result, { expanded, isPartial: false }, plain, context);
      });
      const text = components.flatMap((c: any) => c.render(100)).join("\n");
      for (const name of CODEX_V1_TOOL_NAMES)
        expect(text.match(new RegExp(`^${name}\\b`, "gm"))).toHaveLength(1);
      expect(text).toContain("recognizable child");
      expect(text).toContain("test/gpt-6 high");
      expect(text).not.toContain("hidden JavaScript");
      expect(components[4].render(100)).toEqual([]);
      for (const width of [1, 7, 40])
        for (const component of components)
          expect(component.render(width).every((line: string) => visibleWidth(line) <= width)).toBe(
            true,
          );
    }
    expect(
      h.pi.sendMessage.mock.calls.filter(([m]: any[]) => m.customType === "toolResult"),
    ).toEqual([]);
  },
);

native(
  "tree navigation rejects a late nested resume and disposes its unpublished session once",
  async () => {
    const session = mockSession();
    session.sessionManager = SessionManager.inMemory("/tmp", { id: "late-resume" });
    session.sessionManager.appendMessage({ role: "user", content: "recover", timestamp: 1 });
    vi.mocked(runAgent).mockResolvedValue({ responseText: "done", session });
    const h = await setup();
    const id = values(
      await h.exec('text(await tools.multi_agent_v1__spawn_agent({message:"recover"}))'),
    ).agent_id;
    await h.exec(`await tools.multi_agent_v1__close_agent({target:"${id}"})`);
    const opening = Promise.withResolvers<any>();
    vi.mocked(openAgentSession).mockReturnValueOnce(opening.promise);
    const pending = await h.exec(
      `// @exec: {"yield_time_ms": 0}\nawait tools.multi_agent_v1__resume_agent({id:"${id}"})`,
    );
    const late = mockSession();
    try {
      await vi.waitFor(() => expect(openAgentSession).toHaveBeenCalledOnce());
      h.pi.sendMessage.mockClear();
      await h.emit("session_tree");
    } finally {
      opening.resolve(late);
    }
    await vi.waitFor(() => expect(late.dispose).toHaveBeenCalledOnce());
    expect(h.pi.sendMessage).not.toHaveBeenCalled();
    expect(
      (await h.tools.get("wait").execute("old-wait", { cell_id: pending.details.cellId })).details
        .errorText,
    ).toContain("not found");
    vi.mocked(openAgentSession).mockResolvedValueOnce(mockSession());
    expect(
      values(await h.exec(`text(await tools.multi_agent_v1__resume_agent({id:"${id}"}))`)),
    ).toEqual({ status: "pending_init" });
  },
);

native(
  "branch replacement cancels parallel child command approvals without late launches or stale ctx",
  async () => {
    vi.mocked(runAgent).mockImplementation((_parent, _type, _prompt, options) =>
      waitForCancellation(options.signal),
    );
    const decisions = [Promise.withResolvers<any>(), Promise.withResolvers<any>()];
    const review = vi
      .fn()
      .mockImplementationOnce(() => decisions[0]!.promise)
      .mockImplementationOnce(() => decisions[1]!.promise);
    const h = await setup({ autoMode: { isEnabled: () => true, review } });
    const id = values(
      await h.exec('text(await tools.multi_agent_v1__spawn_agent({message:"approval child"}))'),
    ).agent_id;
    const options = vi.mocked(runAgent).mock.calls[0]![3];
    const childManager = SessionManager.inMemory("/tmp", { id: "approval-child" });
    childManager.appendCustomEntry("pi-bites:subagent", {
      agentId: id,
      type: "worker",
      title: "approval child",
      bashGatePolicy: "prompt",
      agentSessionId: options.agentSessionId,
    });
    options.onSessionCreated?.({ ...mockSession(), messages: [], sessionManager: childManager });
    const gateHandlers = new Map<string, Function>();
    const childPi = {
      events: h.pi.events,
      on: (name: string, fn: Function) => gateHandlers.set(name, fn),
      registerFlag() {},
      registerShortcut() {},
      getFlag: () => false,
      appendEntry: (type: string, data: unknown) => childManager.appendCustomEntry(type, data),
    } as any;
    const gate = registerBashGate(childPi, { current: {} });
    const childCtx = { ...h.ctx, sessionManager: childManager };
    gateHandlers.get("session_start")!({}, childCtx);
    const authorization = gate.captureSession(childCtx);
    const launch = vi.fn();
    const requests = ["rm first.txt", "rm second.txt"].map((command, i) =>
      authorization.authorize(
        { toolCallId: `child-command-${i}`, toolName: "exec_command", command },
        launch,
      ),
    );
    const settled = Promise.allSettled(requests);
    try {
      await vi.waitFor(() => expect(review).toHaveBeenCalledTimes(2));
      expect(review.mock.calls.map(([request]) => [request.toolCallId, request.command])).toEqual([
        ["child-command-0", "rm first.txt"],
        ["child-command-1", "rm second.txt"],
      ]);
      const replacement = { ...h.ctx };
      for (const key of Object.keys(h.ctx))
        Object.defineProperty(h.ctx, key, {
          configurable: true,
          get() {
            throw new Error(`stale ctx.${key}`);
          },
        });
      await h.emit("session_tree", replacement);
      decisions.forEach((decision) => decision.resolve({ outcome: "allow" }));
      expect((await settled).every((result) => result.status === "rejected")).toBe(true);
      expect(launch).not.toHaveBeenCalled();
      expect(h.pi.sendMessage).not.toHaveBeenCalled();
    } finally {
      decisions.forEach((decision) => decision.resolve({ outcome: "deny" }));
      await settled;
      await gateHandlers.get("session_shutdown")?.({});
    }
  },
);

native(
  "cell failure retains a published child while tree navigation disposes late initialization",
  async () => {
    const initialized = Promise.withResolvers<any>();
    vi.mocked(runAgent).mockReturnValueOnce(initialized.promise);
    const h = await setup();
    const result = await h.exec(
      'text(await tools.multi_agent_v1__spawn_agent({message:"published"})); throw new Error("cell failed")',
    );
    expect(result.details.errorText).toContain("cell failed");
    const id = JSON.parse(result.details.output).agent_id;
    expect(
      values(
        await h.exec(
          `text(await tools.multi_agent_v1__send_input({target:"${id}",message:"still controllable"}))`,
        ),
      ),
    ).toEqual({ submission_id: expect.any(String) });
    const options = vi.mocked(runAgent).mock.calls[0]![3];
    expect(options.signal?.aborted).toBe(false);
    const late = mockSession();
    const navigation = h.emit("session_tree");
    try {
      await vi.waitFor(() => expect(options.signal?.aborted).toBe(true));
      options.onSessionCreated?.(late);
    } finally {
      initialized.resolve({ responseText: "late final", session: late });
      await navigation;
    }
    expect(late.dispose).toHaveBeenCalledOnce();
    expect(h.pi.sendMessage).not.toHaveBeenCalled();
    const missing = await h.exec(
      `await tools.multi_agent_v1__send_input({target:"${id}",message:"must not deliver"})`,
    );
    expect(missing.details.errorText).toContain("not found");
  },
);

native.each([
  ["direct", false],
  ["nested", false],
  ["direct", true],
  ["nested", true],
] as const)(
  "%s settled agents accept interrupting input, retain history, and notify independently (initial error: %s)",
  async (surface, initialError) => {
    const session = mockSession();
    session.sessionManager = SessionManager.inMemory("/tmp", { id: "retained-child" });
    session.sessionManager.appendMessage({
      role: "user",
      content: "remember marker",
      timestamp: 1,
    });
    vi.mocked(runAgent).mockImplementation(async (_parent, _type, _prompt, options) => {
      options.onSessionCreated?.(session);
      if (initialError) throw new Error("first final");
      return { responseText: "first final", session };
    });
    vi.mocked(resumeAgent).mockResolvedValue("second final");
    const h = await setup({ adapter: surface === "nested" });
    const call = async (name: string, args: unknown) => {
      if (surface === "direct") return (await h.direct(name, args)).value;
      const result = await h.exec(
        `text(await tools.multi_agent_v1__${name}(${JSON.stringify(args)}))`,
      );
      if (result.details.failed) throw new Error(result.details.errorText);
      return values(result);
    };
    const { agent_id: id } = await call("spawn_agent", { message: "first" });
    expect(await call("wait_agent", { targets: [id] })).toEqual({
      status: { [id]: initialError ? { errored: "first final" } : { completed: "first final" } },
      timed_out: false,
    });
    expect(h.pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "subagent-notification",
        content: expect.stringContaining("first final"),
      }),
      expect.anything(),
    );
    expect(await call("send_input", { target: id, message: "continue", interrupt: true })).toEqual({
      submission_id: expect.any(String),
    });
    expect(await call("wait_agent", { targets: [id] })).toEqual({
      status: { [id]: { completed: "second final" } },
      timed_out: false,
    });
    expect(h.pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "subagent-notification",
        content: expect.stringContaining("second final"),
      }),
      expect.anything(),
    );
    expect(await call("close_agent", { target: id })).toEqual({
      previous_status: { completed: "second final" },
    });
    vi.mocked(openAgentSession).mockImplementation(async (_parent, _type, options) => {
      expect(options.conversation?.sessionId).toBe("retained-child");
      expect(JSON.stringify(options.conversation?.entries)).toContain("remember marker");
      return session;
    });
    expect(await call("resume_agent", { id })).toEqual({ status: "pending_init" });
    expect(
      await call("send_input", { target: id, message: "after reopen", interrupt: true }),
    ).toEqual({ submission_id: expect.any(String) });
    expect(await call("wait_agent", { targets: [id] })).toEqual({
      status: { [id]: { completed: "second final" } },
      timed_out: false,
    });
    await call("close_agent", { target: id });
  },
);

native.each(["direct", "nested"] as const)(
  "%s role validation preserves case and treats blank fork roles as omitted",
  async (surface) => {
    vi.mocked(runAgent).mockImplementation((_parent, _type, _prompt, options) =>
      waitForCancellation(options.signal),
    );
    const h = await setup({ adapter: surface === "nested" });
    const call = async (args: unknown) => {
      if (surface === "direct") return (await h.direct("spawn_agent", args)).value;
      const result = await h.exec(
        `text(await tools.multi_agent_v1__spawn_agent(${JSON.stringify(args)}))`,
      );
      if (result.details.failed) throw new Error(result.details.errorText);
      return values(result);
    };
    await expect(call({ message: "wrong case", agent_type: "EXPLORER" })).rejects.toThrow(
      "unknown agent_type 'EXPLORER'",
    );
    expect(runAgent).not.toHaveBeenCalled();
    expect(await call({ message: "fork", fork_context: true, agent_type: "  " })).toEqual({
      agent_id: expect.any(String),
      nickname: "fork",
    });
    expect(runAgent).toHaveBeenCalledWith(
      expect.anything(),
      "default",
      "fork",
      expect.objectContaining({
        parentEntries: expect.arrayContaining([expect.objectContaining({ type: "message" })]),
      }),
    );
  },
);
