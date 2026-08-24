import type { TrackerRequest } from "../../session-tracker/index.js";
import { afterEach, expect, test, vi } from "vitest";

const { send } = vi.hoisted(() => ({
  send: vi.fn(async (_socketPath: string, _request: TrackerRequest) => ({ ok: true })),
}));

vi.mock("../../session-tracker/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../session-tracker/index.js")>()),
  requestTracker: send,
  spawnSessionTrackerDaemon: vi.fn(),
}));

import registerBashGate from "../bash-gate/index.js";
import registerSessionTracker from "./index.js";

const originalPane = process.env.TMUX_PANE;

afterEach(() => {
  send.mockClear();
  if (originalPane === undefined) delete process.env.TMUX_PANE;
  else process.env.TMUX_PANE = originalPane;
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

test("only human bash reviews report the session as blocked", async () => {
  process.env.TMUX_PANE = "%1";
  const lifecycle = new Map<string, ((...args: any[]) => unknown)[]>();
  const events = new Map<string, Set<(data: unknown) => unknown>>();
  const pi = {
    on(name: string, handler: (...args: any[]) => unknown) {
      lifecycle.set(name, [...(lifecycle.get(name) ?? []), handler]);
    },
    events: {
      on(name: string, handler: (data: unknown) => unknown) {
        const handlers = events.get(name) ?? new Set();
        handlers.add(handler);
        events.set(name, handlers);
        return () => handlers.delete(handler);
      },
      emit(name: string, data: unknown) {
        for (const handler of events.get(name) ?? []) void handler(data);
      },
    },
    registerFlag() {},
    getFlag: () => false,
    registerCommand() {},
    registerShortcut() {},
    appendEntry() {},
  };
  const allowedReview = deferred<{ outcome: "allow" }>();
  const deniedReview = deferred<{ outcome: "deny"; rationale: string }>();
  let autoModeEnabled = true;
  const autoMode = {
    isEnabled: () => autoModeEnabled,
    setEnabled: (enabled: boolean) => {
      autoModeEnabled = enabled;
    },
    review: vi
      .fn()
      .mockImplementationOnce(() => allowedReview.promise)
      .mockImplementationOnce(() => deniedReview.promise),
  };
  const escalationReview = deferred<string>();
  const manualReview = deferred<string>();
  const ctx = {
    cwd: "/repo",
    hasUI: true,
    sessionManager: {
      getEntries: () => [],
      getSessionId: () => "session",
    },
    ui: {
      input: async () => undefined,
      notify() {},
      select: vi
        .fn()
        .mockImplementationOnce(() => escalationReview.promise)
        .mockImplementationOnce(() => manualReview.promise),
      setStatus() {},
    },
  };

  registerBashGate(pi as any, { current: {} }, autoMode);
  registerSessionTracker(pi as any, { current: {} }, autoMode);
  try {
    for (const handler of lifecycle.get("session_start") ?? []) await handler({}, ctx);
    for (const handler of lifecycle.get("agent_start") ?? []) await handler();
    const toolCall = lifecycle.get("tool_call")?.[0];
    expect(toolCall).toBeDefined();
    send.mockClear();

    const automated = toolCall?.({ toolName: "bash", input: { command: "rm file" } }, ctx);
    await vi.waitFor(() => expect(autoMode.review).toHaveBeenCalled());
    expect(
      send.mock.calls.some(
        ([, request]) => request.type === "report" && request.record.state === "needs-permission",
      ),
    ).toBe(false);
    allowedReview.resolve({ outcome: "allow" });
    await automated;

    send.mockClear();
    const escalated = toolCall?.({ toolName: "bash", input: { command: "rm denied-file" } }, ctx);
    await vi.waitFor(() => expect(autoMode.review).toHaveBeenCalledTimes(2));
    expect(
      send.mock.calls.some(
        ([, request]) => request.type === "report" && request.record.state === "needs-permission",
      ),
    ).toBe(false);
    deniedReview.resolve({ outcome: "deny", rationale: "not authorized" });
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          type: "report",
          record: expect.objectContaining({ state: "needs-permission" }),
        }),
      ),
    );

    send.mockClear();
    for (const handler of lifecycle.get("agent_start") ?? []) await handler();
    pi.events.emit("subagents:created", { id: "concurrent-agent" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(
      send.mock.calls.some(
        ([, request]) => request.type === "report" && request.record.state === "working",
      ),
    ).toBe(false);

    send.mockClear();
    pi.events.emit("bites:bash_gate", {
      cwd: "/repo",
      command: "rm concurrently-denied-file",
      requiresHuman: true,
      waitId: "concurrent-human-gate",
    });
    pi.events.emit("bites:bash_gate_resolved", { cwd: "/repo", command: "automated-review" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(
      send.mock.calls.some(
        ([, request]) => request.type === "report" && request.record.state === "working",
      ),
    ).toBe(false);

    escalationReview.resolve("Allow once");
    await escalated;
    await new Promise((resolve) => setImmediate(resolve));
    expect(
      send.mock.calls.some(
        ([, request]) => request.type === "report" && request.record.state === "working",
      ),
    ).toBe(false);

    pi.events.emit("bites:bash_gate_resolved", {
      cwd: "/repo",
      command: "rm concurrently-denied-file",
      requiresHuman: true,
      waitId: "concurrent-human-gate",
    });
    await vi.waitFor(() =>
      expect(send).toHaveBeenLastCalledWith(
        expect.any(String),
        expect.objectContaining({
          type: "report",
          record: expect.objectContaining({ state: "working" }),
        }),
      ),
    );

    autoModeEnabled = false;
    send.mockClear();
    const manual = toolCall?.({ toolName: "bash", input: { command: "rm other-file" } }, ctx);
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          type: "report",
          record: expect.objectContaining({ state: "needs-permission" }),
        }),
      ),
    );
    expect(ctx.ui.select).toHaveBeenCalled();
    manualReview.resolve("Allow");
    await manual;
    await vi.waitFor(() =>
      expect(send).toHaveBeenLastCalledWith(
        expect.any(String),
        expect.objectContaining({
          type: "report",
          record: expect.objectContaining({ state: "working" }),
        }),
      ),
    );

    pi.events.emit("bites:bash_gate", {
      cwd: "/repo",
      command: "old-session-prompt",
      requiresHuman: true,
      waitId: "old-session-gate",
    });
    await vi.waitFor(() =>
      expect(send).toHaveBeenLastCalledWith(
        expect.any(String),
        expect.objectContaining({
          type: "report",
          record: expect.objectContaining({ state: "needs-permission" }),
        }),
      ),
    );

    send.mockClear();
    for (const handler of lifecycle.get("session_start") ?? []) await handler({}, ctx);
    expect(send).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        type: "report",
        record: expect.objectContaining({ state: "idle" }),
      }),
    );

    send.mockClear();
    pi.events.emit("bites:bash_gate_resolved", {
      cwd: "/repo",
      command: "old-session-prompt",
      requiresHuman: true,
      waitId: "old-session-gate",
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(
      send.mock.calls.some(
        ([, request]) => request.type === "report" && request.record.state === "working",
      ),
    ).toBe(false);
  } finally {
    for (const handler of lifecycle.get("session_shutdown") ?? [])
      await handler({ reason: "quit" });
  }
});
