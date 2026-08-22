import { describe, expect, it, vi } from "vitest";
import { createSubagentMessenger, type SubagentSender } from "../subagent-messages.js";

const sender: SubagentSender = {
  id: "agent-1",
  type: "explore",
  title: "trace auth flow",
};

describe("subagent message delivery", () => {
  it("preserves sender identity and exact message text in the parent payload", () => {
    const sendMessage = vi.fn();
    const messenger = createSubagentMessenger({ sendMessage } as any);
    messenger.sessionStarted("parent-1");

    expect(messenger.send("parent-1", sender, "line one\nline <two>")).toBe(true);
    expect(sendMessage.mock.calls[0]?.[0]).toMatchObject({
      content: expect.stringContaining("line &lt;two&gt;"),
      details: { sender, message: "line one\nline <two>" },
    });
  });

  it("persists immediately while idle and waits for agent_settled while active", () => {
    const sendMessage = vi.fn();
    const messenger = createSubagentMessenger({ sendMessage } as any);
    messenger.sessionStarted("parent-1");

    expect(messenger.send("parent-1", sender, "idle message")).toBe(true);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]?.[0]).toMatchObject({
      customType: "subagent-message",
      display: true,
      details: { sender, message: "idle message" },
    });
    expect(sendMessage.mock.calls[0]?.[0].content).toContain("idle message");
    expect(sendMessage.mock.calls[0]?.[1]).toEqual({ triggerTurn: false });

    messenger.agentStarted();
    expect(messenger.send("parent-1", sender, "active message")).toBe(true);
    expect(sendMessage).toHaveBeenCalledTimes(1);

    messenger.agentSettled();
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls[1]?.[0].details.message).toBe("active message");
    expect(sendMessage.mock.calls[1]?.[1]).toEqual({ triggerTurn: false });
  });

  it("flushes multiple messages once in FIFO order before a deferred final", () => {
    const delivered: string[] = [];
    const sendMessage = vi.fn((message: any) => delivered.push(message.details.message));
    const messenger = createSubagentMessenger({ sendMessage } as any);
    messenger.sessionStarted("parent-1");
    messenger.agentStarted();

    expect(messenger.send("parent-1", sender, "first")).toBe(true);
    expect(messenger.send("parent-1", sender, "second")).toBe(true);
    expect(
      messenger.scheduleFinal("parent-1", () => {
        delivered.push("final");
      }),
    ).toBe(true);

    messenger.agentSettled();
    messenger.agentSettled();

    expect(delivered).toEqual(["first", "second", "final"]);
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it("attempts every message and the final when delivery fails", () => {
    const delivered: string[] = [];
    const sendMessage = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("delivery failed");
      })
      .mockImplementationOnce((message: any) => delivered.push(message.details.message));
    const messenger = createSubagentMessenger({ sendMessage } as any);
    messenger.sessionStarted("parent-1");
    messenger.agentStarted();

    messenger.send("parent-1", sender, "first");
    messenger.send("parent-1", sender, "second");
    messenger.scheduleFinal("parent-1", () => delivered.push("final"));
    messenger.agentSettled();

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(delivered).toEqual(["second", "final"]);
  });

  it("shutdown flushes active messages through stable session persistence, never sendMessage", () => {
    const sendMessage = vi.fn();
    const appendCustomMessage = vi.fn();
    const messenger = createSubagentMessenger({ sendMessage } as any);
    messenger.sessionStarted("parent-1", appendCustomMessage);
    messenger.agentStarted();

    messenger.send("parent-1", sender, "first");
    messenger.send("parent-1", sender, "second");
    messenger.flushForShutdown();

    expect(sendMessage).not.toHaveBeenCalled();
    expect(appendCustomMessage.mock.calls.map((call) => call[3].message)).toEqual([
      "first",
      "second",
    ]);
    expect(appendCustomMessage.mock.calls[0]?.slice(0, 3)).toEqual([
      "subagent-message",
      expect.stringContaining("<message>first</message>"),
      true,
    ]);
  });

  it("fails rather than routing messages or finals to a replacement session", () => {
    const sendMessage = vi.fn();
    const final = vi.fn();
    const messenger = createSubagentMessenger({ sendMessage } as any);
    messenger.sessionStarted("another-parent");

    expect(messenger.send("original-parent", sender, "do not reroute")).toBe(false);
    expect(messenger.scheduleFinal("original-parent", final)).toBe(false);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(final).not.toHaveBeenCalled();
  });
});
