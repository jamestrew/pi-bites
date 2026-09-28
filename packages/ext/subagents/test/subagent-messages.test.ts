import { expect, it, vi } from "vitest";
import { createSubagentMessenger, type SubagentSender } from "../subagent-messages.js";

const sender: SubagentSender = {
  id: "agent-1",
  type: "explorer",
  title: "trace auth flow",
};

it("observes native pending activity without consuming it or confusing history with new mail", () => {
  const sendMessage = vi.fn();
  const messenger = createSubagentMessenger({ sendMessage } as any);
  messenger.sessionStarted("a");
  messenger.queueOnly("a", sender, "info");
  messenger.queueOnly("a", sender, "task", true);
  expect(messenger.observe()).toEqual({ revision: 2, pending: 2, pendingTasks: 1 });
  expect(messenger.observe()).toEqual({ revision: 2, pending: 2, pendingTasks: 1 });
  expect(sendMessage.mock.calls.map((call) => call[1])).toEqual([
    { triggerTurn: false },
    { triggerTurn: false },
  ]);
  const messages = sendMessage.mock.calls.map(([message]) => ({ ...message, role: "custom" }));
  messenger.contextPrepared(structuredClone(messages));
  expect(messenger.observe()).toEqual({ revision: 2, pending: 0, pendingTasks: 0 });
  messenger.queueOnly("a", sender, "new info");
  messenger.contextPrepared(messages);
  expect(messenger.observe()).toEqual({ revision: 3, pending: 1, pendingTasks: 0 });
  messenger.dispose();
  sendMessage.mockImplementation(() => {
    throw new Error("invalidated API");
  });
  expect(messenger.queueOnly("a", sender, "late")).toBe(false);
  expect(messenger.observe().pending).toBe(0);
});
