import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../agent-runner.js")>("../agent-runner.js");
  return { ...actual, runAgent: vi.fn(), steerAgent: vi.fn() };
});

import { runAgent, steerAgent } from "../agent-runner.js";
import subagentsExtension from "../index.js";

function makePi(active = ["Agent", "read"]) {
  const tools = new Map<string, any>();
  const handlers = new Map<string, () => void>();
  const eventHandlers = new Map<string, (data: unknown) => void>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((tool: any) => tools.set(tool.name, tool)),
    registerCommand: vi.fn(),
    on: vi.fn((event: string, handler: () => void) => handlers.set(event, handler)),
    events: {
      emit: vi.fn((event: string, data: unknown) => eventHandlers.get(event)?.(data)),
      on: vi.fn((event: string, handler: (data: unknown) => void) => {
        eventHandlers.set(event, handler);
        return vi.fn();
      }),
    },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
    getThinkingLevel: vi.fn(() => "off"),
    getActiveTools: vi.fn(() => active),
    setActiveTools: vi.fn((next: string[]) => (active = next)),
  } as any;
  return { pi, tools, active: () => active, handlers };
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

const textOf = (result: any): string => result.content[0].text;

async function spawnBackground(tools: Map<string, any>) {
  return tools.get("Agent").execute(
    "bg",
    {
      prompt: "go",
      description: "bg",
      subagent_type: "general-purpose",
    },
    undefined,
    undefined,
    ctx(),
  );
}

describe("background helper tools", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps MessageAgent registered without changing active tools at runtime", async () => {
    let finish!: (value: any) => void;
    vi.mocked(runAgent).mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const { pi, tools } = makePi();
    subagentsExtension(pi);

    expect([...tools.keys()]).toContain("Agent");
    expect(tools.get("Agent").parameters.properties).not.toHaveProperty("resume");
    expect(tools.get("Agent").parameters.properties).not.toHaveProperty("inherit_context");
    expect([...tools.keys()]).toContain("MessageAgent");
    expect([...tools.keys()]).not.toContain("get_subagent_result");
    expect([...tools.keys()]).not.toContain("steer_subagent");
    expect(pi.setActiveTools).not.toHaveBeenCalled();

    await spawnBackground(tools);
    expect(pi.setActiveTools).not.toHaveBeenCalled();

    finish({ responseText: "done result", session: { dispose: vi.fn() } as any });
    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalled());

    expect(pi.setActiveTools).not.toHaveBeenCalled();
    const notification = pi.sendMessage.mock.calls[0]?.[0];
    expect(notification.content).toContain("done result");
    expect(notification.content).not.toContain("get_subagent_result");
  });

  it("queues a message while the session initializes", async () => {
    vi.mocked(runAgent).mockReturnValue(new Promise(() => {}));
    const { pi, tools } = makePi();
    subagentsExtension(pi);
    const spawn = await spawnBackground(tools);
    const id = textOf(spawn).match(/Agent ID: (\S+)/)?.[1];

    const result = await tools
      .get("MessageAgent")
      .execute("msg", { agent_id: id, message: "focus here" }, undefined, undefined, ctx());

    expect(textOf(result)).toContain("Message queued");
    expect(pi.events.emit).toHaveBeenCalledWith("subagents:steered", {
      id,
      message: "focus here",
    });
  });

  it("messages a live agent and rejects missing or completed agents", async () => {
    let finish!: (value: any) => void;
    const session = { dispose: vi.fn() } as any;
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options) => {
      options.onSessionCreated?.(session);
      return new Promise((resolve) => (finish = resolve));
    });
    vi.mocked(steerAgent).mockResolvedValue(undefined);
    const { pi, tools } = makePi();
    subagentsExtension(pi);
    const spawn = await spawnBackground(tools);
    const id = textOf(spawn).match(/Agent ID: (\S+)/)?.[1];

    const sent = await tools
      .get("MessageAgent")
      .execute("msg", { agent_id: id, message: "focus here" }, undefined, undefined, ctx());
    expect(textOf(sent)).toContain("Message sent");
    expect(steerAgent).toHaveBeenCalledWith(session, "focus here");

    const missing = await tools
      .get("MessageAgent")
      .execute("msg", { agent_id: "missing", message: "x" }, undefined, undefined, ctx());
    expect(textOf(missing)).toContain("Agent not found");

    finish({ responseText: "done", session });
    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalled());
    const completed = await tools
      .get("MessageAgent")
      .execute("msg", { agent_id: id, message: "again" }, undefined, undefined, ctx());
    expect(textOf(completed)).toContain("is not running (status: completed)");
  });
});
