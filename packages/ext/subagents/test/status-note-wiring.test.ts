/**
 * status-note-wiring.test.ts — proves the status note actually reaches the
 * parent through the real Agent lifecycle, not just that getStatusNote() returns
 * a string. It inspects the automatic completion notification for a user stop.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../agent-runner.js")>("../agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../agent-runner.js";
import subagentsExtension from "../index.js";

function makePi() {
  const tools = new Map<string, any>();
  const handlers = new Map<string, any>();
  const eventHandlers = new Map<string, any>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((t: any) => tools.set(t.name, t)),
    registerCommand: vi.fn(),
    on: vi.fn((event: string, handler: any) => handlers.set(event, handler)),
    events: {
      emit: vi.fn(),
      on: vi.fn((event: string, handler: any) => {
        eventHandlers.set(event, handler);
        return vi.fn();
      }),
    },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
    getThinkingLevel: vi.fn(() => "off"),
  } as any;
  return { pi, tools, handlers, eventHandlers };
}

function ctx() {
  return {
    hasUI: false,
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
    cwd: "/tmp",
    model: undefined,
    modelRegistry: {
      find: vi.fn(),
      getAvailable: vi.fn(() => []),
      getRegisteredProviderIds: vi.fn(() => []),
      getRegisteredProviderConfig: vi.fn(),
    },
    sessionManager: { getSessionId: vi.fn(() => "s1"), getBranch: vi.fn(() => []) },
    getSystemPrompt: vi.fn(() => "parent"),
  } as any;
}

const textOf = (r: any): string => r.content[0].text;
const plainTheme = {
  fg: (_color: string, s: string) => s,
  bold: (s: string) => s,
};

describe("status note reaches the parent through the real handlers", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps launch result details out of the prompt-focused Agent renderer", () => {
    const { pi, tools } = makePi();
    subagentsExtension(pi);

    const lines = tools
      .get("Agent")
      .renderResult(
        {
          content: [{ type: "text", text: "" }],
          details: { status: "running", description: "d", toolUses: 0, toolCalls: [] },
        },
        { expanded: false, isPartial: true },
        plainTheme,
        { args: { prompt: "go" } },
      )
      .render(80);

    expect(lines).toEqual([]);
  });

  it("asynchronous execution publishes the full final response without creating a transcript", async () => {
    const result = "x".repeat(1_000) + "final marker";
    vi.mocked(runAgent).mockResolvedValue({ responseText: result, session: {} as any });
    const { pi, tools, handlers } = makePi();
    subagentsExtension(pi);
    const runCtx = ctx();
    handlers.get("session_start")?.({}, ctx());

    const spawn = await tools.get("Agent").execute(
      "tc1",
      {
        prompt: "go",
        description: "d",
        subagent_type: "general-purpose",
      },
      undefined,
      undefined,
      runCtx,
    );

    expect(textOf(spawn)).not.toContain("Output file:");
    expect(runCtx.sessionManager.getSessionId).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalled());
    const notification = pi.sendMessage.mock.calls[0]?.[0];
    expect(notification.content).toContain(`<result>${result}</result>`);
    expect(notification.content).not.toContain("output-file");
    expect(notification.details).not.toHaveProperty("outputFile");
  });

  it("a user stop is delivered automatically as STOPPED BY THE USER", async () => {
    vi.mocked(runAgent).mockImplementation(
      (_ctx, _type, _prompt, options) =>
        new Promise((_resolve, reject) => {
          options.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const { pi, tools, handlers, eventHandlers } = makePi();
    subagentsExtension(pi);
    const parentCtx = ctx();
    handlers.get("session_start")?.({}, parentCtx);

    const spawn = await tools.get("Agent").execute(
      "tc2",
      {
        prompt: "go",
        description: "d",
        subagent_type: "general-purpose",
      },
      undefined,
      undefined,
      parentCtx,
    );
    const id = textOf(spawn).match(/Agent ID: (\S+)/)?.[1];
    expect(id, "spawn should surface an agent id").toBeTruthy();

    // The user stops it — same path the viewer's stop key uses (manager.abort).
    eventHandlers.get("subagents:rpc:stop")?.({ requestId: "r1", agentId: id });

    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalled());
    const notification = pi.sendMessage.mock.calls[0]?.[0];
    expect(notification.content).toContain("STOPPED BY THE USER");
    expect(notification.content).toContain("the task was NOT finished");
    expect(notification.content).not.toContain("<status>Done</status>");
  });
});
