import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import { createSubagentMessenger } from "../subagent-messages.js";

it("real pi persists idle and settled messages without starting a parent turn", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "subagent-message-e2e-"));
  const sessionManager = SessionManager.inMemory(cwd);
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  const { session } = await createAgentSession({
    cwd,
    tools: [],
    sessionManager,
    resourceLoader: loader,
  });

  let parentTurns = 0;
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "agent_start") parentTurns++;
  });
  const messenger = createSubagentMessenger({
    sendMessage: (message, options) => void session.sendCustomMessage(message, options),
  });
  const sender = { id: "agent-1", type: "explore", title: "trace auth" };

  try {
    messenger.sessionStarted(
      sessionManager.getSessionId(),
      sessionManager.appendCustomMessageEntry.bind(sessionManager),
    );
    expect(messenger.send(sessionManager.getSessionId(), sender, "idle")).toBe(true);
    expect(session.messages.at(-1)).toMatchObject({
      role: "custom",
      customType: "subagent-message",
      details: { sender, message: "idle" },
    });

    messenger.agentStarted();
    expect(messenger.send(sessionManager.getSessionId(), sender, "active one")).toBe(true);
    expect(messenger.send(sessionManager.getSessionId(), sender, "active two")).toBe(true);
    expect(session.messages.at(-1)).toMatchObject({ details: { message: "idle" } });

    messenger.agentSettled();
    expect(
      session.messages
        .filter((message) => message.role === "custom")
        .map((message: any) => message.details.message),
    ).toEqual(["idle", "active one", "active two"]);
    expect(
      sessionManager.getEntries().filter((entry) => entry.type === "custom_message"),
    ).toHaveLength(3);
    expect(parentTurns).toBe(0);

    const steer = vi.spyOn(session.agent, "steer");
    messenger.agentStarted();
    expect(messenger.send(sessionManager.getSessionId(), sender, "shutdown")).toBe(true);
    (session.agent as any)._state.isStreaming = true;

    messenger.flushForShutdown();

    expect(steer).not.toHaveBeenCalled();
    expect(session.messages.filter((message) => message.role === "custom")).toHaveLength(3);
    expect(sessionManager.getEntries().at(-1)).toMatchObject({
      type: "custom_message",
      customType: "subagent-message",
      details: { sender, message: "shutdown" },
    });
    (session.agent as any)._state.isStreaming = false;
  } finally {
    unsubscribe();
    session.dispose();
    rmSync(cwd, { recursive: true, force: true });
  }
});
