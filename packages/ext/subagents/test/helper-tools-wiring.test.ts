import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../agent-runner.js")>("../agent-runner.js");
  return { ...actual, runAgent: vi.fn(), steerAgent: vi.fn() };
});

import { runAgent, steerAgent } from "../agent-runner.js";
import subagentsExtension from "../index.js";

function makePi(active = ["Agent", "read"]) {
  const tools = new Map<string, any>();
  const handlers = new Map<string, (...args: any[]) => void>();
  const eventHandlers = new Map<string, (data: unknown) => void>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((tool: any) => tools.set(tool.name, tool)),
    registerCommand: vi.fn(),
    on: vi.fn((event: string, handler: (...args: any[]) => void) => handlers.set(event, handler)),
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

function ctx(idle = true) {
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
    sessionManager: {
      getSessionId: vi.fn(() => "s1"),
      getBranch: vi.fn(() => []),
      appendCustomMessageEntry: vi.fn(),
    },
    getSystemPrompt: vi.fn(() => "parent"),
    isIdle: vi.fn(() => idle),
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
    const { pi, tools, handlers } = makePi();
    subagentsExtension(pi);
    handlers.get("session_start")?.({}, ctx());

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

  it("queues child messages until the parent agent settles", async () => {
    let messageParent: ((message: string) => boolean) | undefined;
    vi.mocked(runAgent).mockImplementation((_parent, _type, _prompt, options) => {
      messageParent = options.messageParent;
      return new Promise(() => {});
    });
    const { pi, tools, handlers } = makePi();
    subagentsExtension(pi);
    handlers.get("session_start")?.({}, ctx());
    handlers.get("agent_start")?.({}, ctx());

    await spawnBackground(tools);
    expect(messageParent?.("need a decision")).toBe(true);
    expect(pi.sendMessage).not.toHaveBeenCalled();

    handlers.get("agent_settled")?.({}, ctx());
    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "subagent-message",
        details: expect.objectContaining({ message: "need a decision" }),
      }),
      { triggerTurn: false },
    );
  });

  it("delivers queued messages in order before an immediately completed child's final", async () => {
    let messageParent: ((message: string) => boolean) | undefined;
    let finish!: (value: any) => void;
    vi.mocked(runAgent).mockImplementation((_parent, _type, _prompt, options) => {
      messageParent = options.messageParent;
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const { pi, tools, handlers } = makePi();
    subagentsExtension(pi);
    handlers.get("session_start")?.({}, ctx());
    handlers.get("agent_start")?.({}, ctx());

    await spawnBackground(tools);
    expect(messageParent?.("first")).toBe(true);
    expect(messageParent?.("second")).toBe(true);
    finish({ responseText: "done", session: { dispose: vi.fn() } as any });
    await Promise.resolve();
    await Promise.resolve();
    expect(pi.sendMessage).not.toHaveBeenCalled();

    handlers.get("agent_settled")?.({}, ctx());

    expect(pi.sendMessage.mock.calls.map(([message]: any[]) => message.customType)).toEqual([
      "subagent-message",
      "subagent-message",
      "subagent-notification",
    ]);
    expect(pi.sendMessage.mock.calls.map(([message]: any[]) => message.details.message)).toEqual([
      "first",
      "second",
      undefined,
    ]);
    expect(pi.sendMessage.mock.calls.map(([, options]: any[]) => options)).toEqual([
      { triggerTurn: false },
      { triggerTurn: false },
      { deliverAs: "steer", triggerTurn: true },
    ]);
  });

  it("keeps child messages queued when an earlier settled handler starts another run", async () => {
    let messageParent: ((message: string) => boolean) | undefined;
    vi.mocked(runAgent).mockImplementation((_parent, _type, _prompt, options) => {
      messageParent = options.messageParent;
      return new Promise(() => {});
    });
    const { pi, tools, handlers } = makePi();
    subagentsExtension(pi);
    handlers.get("session_start")?.({}, ctx());
    handlers.get("agent_start")?.({}, ctx());

    await spawnBackground(tools);
    expect(messageParent?.("still pending")).toBe(true);

    handlers.get("agent_settled")?.({}, ctx(false));
    handlers.get("agent_start")?.({}, ctx());
    expect(pi.sendMessage).not.toHaveBeenCalled();

    handlers.get("agent_settled")?.({}, ctx());
    handlers.get("agent_settled")?.({}, ctx());
    expect(pi.sendMessage).toHaveBeenCalledOnce();
    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "subagent-message",
        details: expect.objectContaining({ message: "still pending" }),
      }),
      { triggerTurn: false },
    );
  });

  it("best-effort flushes before shutdown without dereferencing replaced context", async () => {
    const order: string[] = [];
    let messageParent: ((message: string) => boolean) | undefined;
    vi.mocked(runAgent).mockImplementation((_parent, _type, _prompt, options) => {
      messageParent = options.messageParent;
      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener(
          "abort",
          () => {
            order.push("abort");
            reject(new Error("aborted"));
          },
          { once: true },
        );
      });
    });
    const { pi, tools, handlers } = makePi();
    const parentCtx = ctx();
    parentCtx.sessionManager.appendCustomMessageEntry
      .mockImplementationOnce(
        (_type: string, _content: string, _display: boolean, details: any) => {
          order.push(details.message);
          throw new Error("delivery failed");
        },
      )
      .mockImplementationOnce((_type: string, _content: string, _display: boolean, details: any) =>
        order.push(details.message),
      );
    subagentsExtension(pi);
    handlers.get("session_start")?.({}, parentCtx);
    handlers.get("agent_start")?.({}, parentCtx);

    await spawnBackground(tools);
    expect(messageParent?.("first")).toBe(true);
    expect(messageParent?.("second")).toBe(true);
    handlers.get("session_before_switch")?.({}, parentCtx);
    for (const key of ["sessionManager", "isIdle"] as const) {
      Object.defineProperty(parentCtx, key, {
        get: () => {
          throw new Error("stale ctx");
        },
      });
    }

    handlers.get("session_shutdown")?.({}, parentCtx);

    expect(order).toEqual(["first", "second", "abort"]);
    expect(messageParent?.("too late")).toBe(false);
  });

  it("renders partial MessageAgent arguments while they stream", () => {
    const { pi, tools } = makePi();
    subagentsExtension(pi);

    const component = tools
      .get("MessageAgent")
      .renderCall(
        {},
        { fg: (_color: string, text: string) => text, bold: (text: string) => text },
        { state: {} },
      );

    expect(component.render(80)).toEqual(["MessageAgent → ", "  "]);
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
    expect(result.details).toMatchObject({
      status: "queued",
      recipient: "bg",
      message: "focus here",
    });
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
    const { pi, tools, handlers } = makePi();
    subagentsExtension(pi);
    handlers.get("session_start")?.({}, ctx());
    const spawn = await spawnBackground(tools);
    const id = textOf(spawn).match(/Agent ID: (\S+)/)?.[1];

    const sent = await tools
      .get("MessageAgent")
      .execute("msg", { agent_id: id, message: "focus here" }, undefined, undefined, ctx());
    expect(textOf(sent)).toContain("Message sent");
    expect(sent.details).toMatchObject({
      status: "sent",
      recipient: "bg",
      message: "focus here",
    });
    const messageTool = tools.get("MessageAgent");
    expect(
      messageTool
        .renderCall(
          { agent_id: id, message: "focus here" },
          { fg: (_color: string, text: string) => text, bold: (text: string) => text },
          { toolCallId: "live", state: {} },
        )
        .render(80),
    ).toEqual(["MessageAgent → bg", "  focus here"]);

    const restoredState = {};
    const restored = messageTool.renderCall(
      { agent_id: "cleaned-up", message: "persisted" },
      { fg: (_color: string, text: string) => text, bold: (text: string) => text },
      { toolCallId: "restored", state: restoredState },
    );
    messageTool.renderResult(
      {
        content: [],
        details: { status: "sent", recipient: "saved title", message: "persisted" },
      },
      { expanded: false, isPartial: false },
      { fg: (_color: string, text: string) => text, bold: (text: string) => text },
      { toolCallId: "restored", state: restoredState },
    );
    expect(restored.render(80)[0]).toBe("MessageAgent → saved title");
    expect(steerAgent).toHaveBeenCalledWith(session, "focus here");

    const missing = await tools
      .get("MessageAgent")
      .execute("msg", { agent_id: "missing", message: "x" }, undefined, undefined, ctx());
    expect(textOf(missing)).toContain("Agent not found");
    expect(missing.details).toMatchObject({ status: "failed", message: "x" });

    finish({ responseText: "done", session });
    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalled());
    const completed = await tools
      .get("MessageAgent")
      .execute("msg", { agent_id: id, message: "again" }, undefined, undefined, ctx());
    expect(textOf(completed)).toContain("is not running (status: completed)");
  });
});
