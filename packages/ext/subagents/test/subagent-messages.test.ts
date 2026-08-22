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

  it("fails rather than routing to a replacement session", () => {
    const sendMessage = vi.fn();
    const messenger = createSubagentMessenger({ sendMessage } as any);
    messenger.sessionStarted("another-parent");

    expect(messenger.send("original-parent", sender, "do not reroute")).toBe(false);
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
