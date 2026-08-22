/**
 * fleet-wiring.test.ts — end-to-end wiring of the FleetView through the REAL
 * extension (src/index.ts), not the FleetList class in isolation.
 *
 * The unit tests in fleet-list.test.ts drive FleetList with a fake ui/manager.
 * These prove the bits only the extension can: that `tool_execution_start`
 * hands the fleet the live UI (so it captures input), that spawning an
 * agent actually registers the `aboveEditor` widget once the agent has a session,
 * and that `session_shutdown` tears it down. runAgent is mocked (no LLM); the
 * manager, settings load, completion routing, and lifecycle handlers are real.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../agent-runner.js")>("../agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../agent-runner.js";
import subagentsExtension from "../index.js";

function makePi() {
  const tools = new Map<string, any>();
  const lifecycle = new Map<string, any>();
  const eventHandlers = new Map<string, Array<(data: unknown) => unknown>>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((t: any) => tools.set(t.name, t)),
    registerCommand: vi.fn(),
    on: vi.fn((event: string, handler: any) => lifecycle.set(event, handler)),
    events: {
      emit: vi.fn((event: string, data: unknown) => {
        for (const handler of eventHandlers.get(event) ?? []) void handler(data);
      }),
      on: vi.fn((event: string, handler: (data: unknown) => unknown) => {
        const handlers = eventHandlers.get(event) ?? [];
        handlers.push(handler);
        eventHandlers.set(event, handlers);
        return () =>
          eventHandlers.set(
            event,
            handlers.filter((h) => h !== handler),
          );
      }),
    },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
    getThinkingLevel: vi.fn(() => "off"),
  } as any;
  return { pi, tools, lifecycle };
}

/** A UI context with the surfaces the widget + fleet touch; setWidget is spied. */
function uiCtx() {
  let inputHandler: ((data: string) => { consume?: boolean } | undefined) | undefined;
  let fleetWidget: ((tui: any, theme: any) => { render(width: number): string[] }) | undefined;
  const tui = { requestRender: vi.fn(), terminal: { columns: 160, rows: 40 } };
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
  return {
    setStatus: vi.fn(),
    setWidget: vi.fn((key: string, content: unknown, _options?: unknown) => {
      if (key === "fleet")
        fleetWidget = typeof content === "function" ? (content as any) : undefined;
    }),
    notify: vi.fn(),
    onTerminalInput: vi.fn((handler) => {
      inputHandler = handler;
      return () => {
        inputHandler = undefined;
      };
    }),
    getEditorText: vi.fn(() => ""),
    input: vi.fn(async () => undefined as string | undefined),
    select: vi.fn(async () => "Deny"),
    custom: vi.fn(),
    press: (data: string) => inputHandler?.(data),
    renderFleet: (width = 160) => fleetWidget?.(tui, theme).render(width) ?? [],
  };
}

function ctxWith(ui: ReturnType<typeof uiCtx>) {
  return {
    hasUI: true,
    ui,
    cwd: process.cwd(),
    model: undefined,
    modelRegistry: {
      find: vi.fn(),
      getAvailable: vi.fn(() => []),
      getRegisteredProviderIds: vi.fn(() => []),
      getRegisteredProviderConfig: vi.fn(),
    },
    sessionManager: { getSessionId: () => "s1", getBranch: () => [] },
    getSystemPrompt: () => "parent",
  } as any;
}

const textOf = (r: any): string => r.content[0].text;
const flush = async () => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
};

function expectStableFleetRow(ui: ReturnType<typeof uiCtx>, description: string, command: string) {
  const lines = ui.renderFleet();
  const agentLine = lines.find((line) => line.includes(description));
  expect(agentLine).toContain("↓ 0 tokens");
  expect(agentLine).toMatch(/\d+s · ↓/);
  expect(lines.join("\n")).not.toContain(command);
}

describe("FleetView wiring (real extension lifecycle)", () => {
  let tmpDir: string;
  let agentDir: string;
  let prevCwd: string;
  let prevAgentDir: string | undefined;
  let prevHome: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-fleet-"));
    agentDir = mkdtempSync(join(tmpdir(), "pi-fleet-agentdir-"));
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    prevHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.HOME = agentDir;
    prevCwd = process.cwd();
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(prevCwd);
    if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    if (prevHome == null) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("captures terminal input on tool_execution_start (fleet hooked into the UI)", async () => {
    const { pi, lifecycle } = makePi();
    subagentsExtension(pi);
    const ui = uiCtx();
    await lifecycle.get("tool_execution_start")?.({}, ctxWith(ui));
    expect(ui.onTerminalInput).toHaveBeenCalled();
  });

  it("inherits parent yolo mode without prompting or automode review", async () => {
    const { pi, lifecycle } = makePi();
    const review = vi.fn().mockResolvedValue({ outcome: "deny" });
    subagentsExtension(
      pi,
      { current: {} },
      { isEnabled: () => true, review },
      { isYolo: () => true },
    );
    await lifecycle.get("session_start")?.({}, { ...ctxWith(uiCtx()), hasUI: false });

    const reply = vi.fn();
    pi.events.on("subagents:bash_gate:approval:reply:r-yolo", reply);
    pi.events.emit("subagents:bash_gate:approval", {
      requestId: "r-yolo",
      title: "general",
      command: "rm build.txt",
      labels: ["rm"],
      reasons: [],
      sessionAllowKey: "rm",
    });
    await flush();

    expect(reply).toHaveBeenCalledWith({ result: { outcome: "allow" } });
    expect(review).not.toHaveBeenCalled();
  });

  it("fails closed without dereferencing stale context during a session switch", async () => {
    const { pi, lifecycle } = makePi();
    subagentsExtension(pi, { current: {} }, undefined, { isYolo: () => false });
    const ctx = ctxWith(uiCtx());
    await lifecycle.get("session_start")?.({}, ctx);
    await lifecycle.get("session_before_switch")?.({}, ctx);
    for (const key of ["ui", "hasUI", "cwd"] as const) {
      Object.defineProperty(ctx, key, {
        get: () => {
          throw new Error("stale ctx");
        },
      });
    }

    const reply = vi.fn();
    pi.events.on("subagents:bash_gate:approval:reply:r-switch", reply);
    pi.events.emit("subagents:bash_gate:approval", {
      requestId: "r-switch",
      title: "general",
      command: "rm build.txt",
      labels: ["rm"],
      reasons: [],
      sessionAllowKey: "rm",
    });
    await flush();

    expect(reply).toHaveBeenCalledWith({
      result: { outcome: "failure", message: "parent approval context unavailable" },
    });
  });

  it("prompts for subagent approval when parent yolo and automode are off", async () => {
    const { pi, lifecycle } = makePi();
    const ui = uiCtx();
    ui.select.mockResolvedValue("Allow");
    subagentsExtension(pi, { current: {} }, undefined, { isYolo: () => false });
    await lifecycle.get("session_start")?.({}, ctxWith(ui));

    const reply = vi.fn();
    pi.events.on("subagents:bash_gate:approval:reply:r-manual", reply);
    pi.events.emit("subagents:bash_gate:approval", {
      requestId: "r-manual",
      title: "general",
      command: "rm build.txt",
      labels: ["rm"],
      reasons: [],
      sessionAllowKey: "rm",
    });
    await flush();

    expect(ui.select).toHaveBeenCalledOnce();
    expect(reply).toHaveBeenCalledWith({ result: { outcome: "allow" } });
  });

  it("keeps the FleetView row stable while manual subagent approval is pending", async () => {
    vi.mocked(runAgent).mockReturnValue(new Promise(() => {}));
    const { pi, tools, lifecycle } = makePi();
    const ui = uiCtx();
    let resolveSelect!: (choice: string) => void;
    ui.select.mockImplementation(() => new Promise<string>((resolve) => (resolveSelect = resolve)));
    subagentsExtension(pi, { current: {} }, undefined, { isYolo: () => false });
    const ctx = ctxWith(ui);
    await lifecycle.get("session_start")?.({}, ctx);
    await lifecycle.get("tool_execution_start")?.({}, ctx);
    const spawn = await tools
      .get("Agent")
      .execute(
        "tc",
        { prompt: "go", description: "stable manual row", subagent_type: "general-purpose" },
        undefined,
        undefined,
        ctx,
      );
    const agentId = textOf(spawn).match(/Agent ID: ([\w-]+)/)?.[1];

    pi.events.emit("bites:bash_gate", {});
    pi.events.emit("subagents:bash_gate:approval", {
      requestId: "r-manual-pending",
      agentId,
      title: "general",
      command: "git push origin main",
      labels: ["git push"],
      reasons: [],
      sessionAllowKey: "git push",
    });
    await flush();

    expect(ui.select).toHaveBeenCalledOnce();
    expectStableFleetRow(ui, "stable manual row", "git push origin main");

    resolveSelect("Deny");
    pi.events.emit("bites:bash_gate_resolved", {});
    await flush();
    await lifecycle.get("session_shutdown")?.({}, ctx);
  });

  it("routes subagent bash approvals through automode without UI", async () => {
    const { pi, lifecycle } = makePi();
    const review = vi.fn().mockResolvedValue({ outcome: "allow" });
    subagentsExtension(pi, { current: {} }, { isEnabled: () => true, review });
    const ctx = { ...ctxWith(uiCtx()), hasUI: false };
    await lifecycle.get("session_start")?.({}, ctx);

    const reply = vi.fn();
    pi.events.on("subagents:bash_gate:approval:reply:r1", reply);
    pi.events.emit("subagents:bash_gate:approval", {
      requestId: "r1",
      title: "general",
      command: "git commit -m test",
      labels: ["git commit"],
      reasons: [],
      sessionAllowKey: "git commit",
    });
    await flush();

    expect(review).toHaveBeenCalledWith(
      {
        command: "git commit -m test",
        labels: ["git commit"],
        reasons: [],
        subagentContext: "<subagent context unavailable>",
      },
      ctx,
    );
    expect(reply).toHaveBeenCalledWith({ result: { outcome: "allow" } });
  });

  it("keeps the FleetView row stable while Automode reviews a subagent command", async () => {
    vi.mocked(runAgent).mockReturnValue(new Promise(() => {}));
    const { pi, tools, lifecycle } = makePi();
    let resolveReview!: (decision: { outcome: "allow" }) => void;
    const review = vi.fn(
      () => new Promise<{ outcome: "allow" }>((resolve) => (resolveReview = resolve)),
    );
    subagentsExtension(pi, { current: {} }, { isEnabled: () => true, review });
    const ui = uiCtx();
    const ctx = ctxWith(ui);
    await lifecycle.get("session_start")?.({}, ctx);
    await lifecycle.get("tool_execution_start")?.({}, ctx);
    const spawn = await tools
      .get("Agent")
      .execute(
        "tc",
        { prompt: "go", description: "stable Automode row", subagent_type: "general-purpose" },
        undefined,
        undefined,
        ctx,
      );
    const agentId = textOf(spawn).match(/Agent ID: ([\w-]+)/)?.[1];

    pi.events.emit("bites:bash_gate", {});
    pi.events.emit("subagents:bash_gate:approval", {
      requestId: "r-automode-pending",
      agentId,
      title: "general",
      command: "rm build.txt",
      labels: ["rm"],
      reasons: [],
      sessionAllowKey: "rm",
    });
    await flush();

    expect(review).toHaveBeenCalledOnce();
    expectStableFleetRow(ui, "stable Automode row", "rm build.txt");

    resolveReview({ outcome: "allow" });
    pi.events.emit("bites:bash_gate_resolved", {});
    await flush();
    await lifecycle.get("session_shutdown")?.({}, ctx);
  });

  it("keeps a no-UI subagent Automode denial fail-closed", async () => {
    const { pi, lifecycle } = makePi();
    const review = vi.fn().mockResolvedValue({ outcome: "deny", rationale: "not authorized" });
    subagentsExtension(pi, { current: {} }, { isEnabled: () => true, review });
    const ui = uiCtx();
    const ctx = { ...ctxWith(ui), hasUI: false };
    await lifecycle.get("session_start")?.({}, ctx);

    const reply = vi.fn();
    pi.events.on("subagents:bash_gate:approval:reply:r-deny", reply);
    pi.events.emit("subagents:bash_gate:approval", {
      requestId: "r-deny",
      title: "general",
      command: "rm build.txt",
      labels: ["rm"],
      reasons: [],
      sessionAllowKey: "rm",
    });
    await flush();

    expect(reply).toHaveBeenCalledWith({
      result: { outcome: "deny", source: "automode", rationale: "not authorized" },
    });
    expect(ui.select).not.toHaveBeenCalled();
  });

  it("returns a distinct failure reply when no-UI automode review throws", async () => {
    const { pi, lifecycle } = makePi();
    const review = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("request aborted"), { name: "AbortError" }));
    subagentsExtension(pi, { current: {} }, { isEnabled: () => true, review });
    const ctx = { ...ctxWith(uiCtx()), hasUI: false };
    await lifecycle.get("session_start")?.({}, ctx);

    const reply = vi.fn();
    pi.events.on("subagents:bash_gate:approval:reply:r-failure", reply);
    pi.events.emit("subagents:bash_gate:approval", {
      requestId: "r-failure",
      title: "general",
      command: "rm build.txt",
      labels: ["rm"],
      reasons: [],
      sessionAllowKey: "rm",
    });
    await flush();

    expect(reply).toHaveBeenCalledWith({
      result: { outcome: "failure", message: "Automode reviewer failed: request aborted" },
    });
  });

  it("lets the interactive human allow a subagent Automode denial with a remembered reason", async () => {
    const { pi, lifecycle } = makePi();
    let stale = false;
    const review = vi.fn().mockImplementation(async () => {
      stale = true;
      return { outcome: "deny", rationale: "not authorized" };
    });
    subagentsExtension(pi, { current: {} }, { isEnabled: () => true, review });
    const ui = uiCtx();
    ui.select.mockResolvedValue("Allow with reason…");
    ui.input.mockResolvedValue("Generated test output");
    const ctx = ctxWith(ui);
    for (const [key, value] of [
      ["ui", ui],
      ["hasUI", true],
      ["cwd", process.cwd()],
    ] as const) {
      Object.defineProperty(ctx, key, {
        get: () => {
          if (stale) throw new Error("stale ctx");
          return value;
        },
      });
    }
    await lifecycle.get("session_start")?.({}, ctx);

    const reply = vi.fn();
    pi.events.on("subagents:bash_gate:approval:reply:r-override", reply);
    pi.events.emit("subagents:bash_gate:approval", {
      requestId: "r-override",
      title: "general",
      command: "rm build.txt",
      labels: ["rm"],
      reasons: [],
      sessionAllowKey: "rm",
    });
    await flush();

    expect(ui.select).toHaveBeenCalledWith(expect.stringContaining("not authorized"), [
      "Allow once",
      "Allow with reason…",
      "Export command",
      "Deny",
    ]);
    expect(pi.events.emit).toHaveBeenCalledWith(
      "bites:bash_gate",
      expect.objectContaining({
        cwd: process.cwd(),
        command: "rm build.txt",
        requiresHuman: true,
        waitId: expect.any(String),
      }),
    );
    expect(pi.events.emit).toHaveBeenCalledWith(
      "bites:bash_gate_resolved",
      expect.objectContaining({
        cwd: process.cwd(),
        command: "rm build.txt",
        requiresHuman: true,
        waitId: expect.any(String),
      }),
    );
    expect(pi.appendEntry).toHaveBeenCalledWith("pi-bites:automode-override", {
      version: 1,
      command: "rm build.txt",
      reason: "Generated test output",
    });
    expect(reply).toHaveBeenCalledWith({ result: { outcome: "allow" } });
  });

  it("keeps the original subagent denial when interactive escalation fails", async () => {
    const { pi, lifecycle } = makePi();
    const review = vi.fn().mockResolvedValue({ outcome: "deny", rationale: "not authorized" });
    subagentsExtension(pi, { current: {} }, { isEnabled: () => true, review });
    const ui = uiCtx();
    ui.select.mockRejectedValue(new Error("UI unavailable"));
    const ctx = ctxWith(ui);
    await lifecycle.get("session_start")?.({}, ctx);

    const reply = vi.fn();
    pi.events.on("subagents:bash_gate:approval:reply:r-ui-failure", reply);
    pi.events.emit("subagents:bash_gate:approval", {
      requestId: "r-ui-failure",
      title: "general",
      command: "rm build.txt",
      labels: ["rm"],
      reasons: [],
      sessionAllowKey: "rm",
    });
    await flush();

    expect(ui.notify).toHaveBeenCalledWith(
      "Automode escalation failed closed: Error: UI unavailable",
      "error",
    );
    expect(reply).toHaveBeenCalledWith({
      result: { outcome: "deny", source: "automode", rationale: "not authorized" },
    });
  });

  it("forwards bounded surfaced subagent context to automode", async () => {
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "done",
      session: {
        messages: [
          { role: "user", content: "inspect generated files" },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "hidden plan" },
              { type: "text", text: "build.txt is generated" },
            ],
          },
          ...Array.from({ length: 7 }, (_, index) => ({
            role: "assistant",
            content: `older surfaced output ${index} ${"x".repeat(8_000)}`,
          })),
          { role: "user", content: "only remove generated build.txt" },
        ],
        dispose: vi.fn(),
      } as any,
    });
    const { pi, tools, lifecycle } = makePi();
    const review = vi.fn().mockResolvedValue({ outcome: "deny", rationale: "not authorized" });
    subagentsExtension(pi, { current: {} }, { isEnabled: () => true, review });
    const ui = uiCtx();
    const ctx = ctxWith(ui);
    await lifecycle.get("session_start")?.({}, ctx);
    const spawn = await tools.get("Agent").execute(
      "tc",
      {
        prompt: "go",
        description: "review context",
        subagent_type: "general-purpose",
      },
      undefined,
      undefined,
      ctx,
    );
    await flush();
    const agentId = textOf(spawn).match(/Agent ID: ([\w-]+)/)?.[1];
    ui.select.mockResolvedValueOnce("View conversation").mockResolvedValueOnce("Deny");

    const reply = vi.fn();
    pi.events.on("subagents:bash_gate:approval:reply:r2", reply);
    pi.events.emit("subagents:bash_gate:approval", {
      requestId: "r2",
      agentId,
      title: "general",
      command: "rm build.txt",
      labels: ["rm"],
      reasons: [],
      sessionAllowKey: "rm",
    });
    await flush();

    const request = review.mock.calls[0]?.[0];
    expect(request.command).toBe("rm build.txt");
    expect(request.subagentContext).toContain("user: inspect generated files");
    expect(request.subagentContext).toContain("assistant: build.txt is generated");
    expect(request.subagentContext).toContain("user: only remove generated build.txt");
    expect(request.subagentContext).toContain("<... transcript entries omitted ...>");
    expect(request.subagentContext.length).toBeLessThanOrEqual(40_000);
    expect(request.subagentContext).not.toContain("hidden plan");
    expect(ui.select).toHaveBeenCalledWith(
      expect.stringContaining("not authorized"),
      expect.arrayContaining(["View conversation"]),
    );
    expect(ui.select).toHaveBeenCalledTimes(2);
    expect(ui.custom).toHaveBeenCalledOnce();
    expect(reply).toHaveBeenCalledWith({
      result: { outcome: "deny", source: "automode", rationale: "not authorized" },
    });
  });

  it("yields terminal input between bash-gate pending and resolved events", async () => {
    vi.mocked(runAgent).mockReturnValue(new Promise(() => {}));
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const ui = uiCtx();
    const ctx = ctxWith(ui);
    await lifecycle.get("tool_execution_start")?.({}, ctx);
    await tools.get("Agent").execute(
      "tc",
      {
        prompt: "go",
        description: "live one",
        subagent_type: "general-purpose",
      },
      undefined,
      undefined,
      ctx,
    );

    expect(ui.press("\x1b[1;5A")).toEqual({ consume: true });
    pi.events.emit("bites:bash_gate", {});
    expect(ui.press("\r")).toBeUndefined();
    expect(ui.press("\x1b")).toBeUndefined();
    expect(ui.custom).not.toHaveBeenCalled();

    pi.events.emit("bites:bash_gate_resolved", {});
    expect(ui.press("\x1b[1;5A")).toEqual({ consume: true });
    await lifecycle.get("session_shutdown")?.({}, ctx);
  });

  it("registers the aboveEditor widget once a spawned agent has a session, then clears it on shutdown", async () => {
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "done",
      session: { dispose: vi.fn() } as any,
    });

    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);

    const ui = uiCtx();
    await lifecycle.get("tool_execution_start")?.({}, ctxWith(ui)); // fleet captures THIS ui

    const spawn = await tools.get("Agent").execute(
      "tc",
      {
        prompt: "go",
        description: "live one",
        subagent_type: "general-purpose",
      },
      undefined,
      undefined,
      ctxWith(uiCtx()),
    );
    expect(textOf(spawn)).toMatch(/Agent ID:/);
    await flush(); // completion → fleet.onAgentFinished → update → widget registers

    const fleetRegs = ui.setWidget.mock.calls.filter(
      (c) => c[0] === "fleet" && typeof c[1] === "function",
    );
    expect(fleetRegs.length, "fleet widget should register with a render factory").toBeGreaterThan(
      0,
    );
    expect(fleetRegs.at(-1)?.[2]).toEqual({ placement: "aboveEditor" });

    await lifecycle.get("session_shutdown")?.({}, ctxWith(uiCtx()));
    expect(ui.setWidget).toHaveBeenCalledWith("fleet", undefined); // dispose cleared it
  });
});
