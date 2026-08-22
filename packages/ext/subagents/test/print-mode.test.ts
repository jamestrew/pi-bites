import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../agent-runner.js")>("../agent-runner.js");
  return {
    ...actual,
    runAgent: vi.fn(),
  };
});

import { runAgent } from "../agent-runner.js";
import subagentsExtension from "../index.js";

function makePi() {
  const tools = new Map<string, any>();
  const handlers = new Map<string, any>();
  const eventHandlers = new Map<string, any>();

  return {
    pi: {
      registerMessageRenderer: vi.fn(),
      registerTool: vi.fn((tool: any) => {
        tools.set(tool.name, tool);
      }),
      registerCommand: vi.fn(),
      on: vi.fn((event: string, handler: any) => {
        handlers.set(event, handler);
      }),
      events: {
        emit: vi.fn(),
        on: vi.fn((event: string, handler: any) => {
          eventHandlers.set(event, handler);
          return vi.fn();
        }),
      },
      appendEntry: vi.fn(),
      getThinkingLevel: vi.fn(() => "off"),
      sendMessage: vi.fn(() => {
        throw new Error("stale extension context");
      }),
    } as any,
    tools,
    handlers,
  };
}

function makeHeadlessCtx() {
  return {
    hasUI: false,
    ui: {
      setStatus: vi.fn(),
      setWidget: vi.fn(),
    },
    cwd: "/tmp",
    model: undefined,
    modelRegistry: {
      find: vi.fn(),
      getAvailable: vi.fn(() => []),
      getRegisteredProviderIds: vi.fn(() => []),
      getRegisteredProviderConfig: vi.fn(),
    },
    sessionManager: {
      getSessionId: vi.fn(() => "session-1"),
      getBranch: vi.fn(() => []),
    },
    getSystemPrompt: vi.fn(() => "parent prompt"),
  } as any;
}

describe("print mode completion notifications", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("delivers completion without capturing the tool context", async () => {
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "done",
      session: { dispose: vi.fn() } as any,
    });

    const { pi, tools, handlers } = makePi();
    subagentsExtension(pi);
    handlers.get("session_start")?.({}, makeHeadlessCtx());

    const agentTool = tools.get("Agent");
    await agentTool.execute(
      "tool-call-1",
      {
        prompt: "reply done",
        description: "tiny child",
        subagent_type: "general-purpose",
      },
      undefined,
      undefined,
      makeHeadlessCtx(),
    );

    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalled());

    await handlers.get("session_shutdown")?.({}, makeHeadlessCtx());
  });
});
