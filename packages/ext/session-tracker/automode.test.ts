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

import type { AutoModeController } from "../automode/index.js";
import registerSessionTracker from "./index.js";

const originalPane = process.env.TMUX_PANE;

afterEach(() => {
  send.mockClear();
  if (originalPane === undefined) delete process.env.TMUX_PANE;
  else process.env.TMUX_PANE = originalPane;
});

test("automode bash review never reports the session as blocked", async () => {
  process.env.TMUX_PANE = "%1";
  const lifecycle = new Map<string, (...args: any[]) => unknown>();
  const events = new Map<string, (...args: any[]) => unknown>();
  const pi = {
    on: (name: string, handler: (...args: any[]) => unknown) => lifecycle.set(name, handler),
    events: {
      on: (name: string, handler: (...args: any[]) => unknown) => events.set(name, handler),
    },
    registerCommand() {},
    registerShortcut() {},
  };
  let autoModeEnabled = false;
  const autoMode = { isEnabled: () => autoModeEnabled } as AutoModeController;

  registerSessionTracker(pi as any, { current: {} }, autoMode);
  const sessionStart = lifecycle.get("session_start");
  const sessionShutdown = lifecycle.get("session_shutdown");
  const bashGate = events.get("bites:bash_gate");
  const bashGateResolved = events.get("bites:bash_gate_resolved");
  expect(sessionStart).toBeDefined();
  expect(sessionShutdown).toBeDefined();
  expect(bashGate).toBeDefined();
  expect(bashGateResolved).toBeDefined();

  try {
    await sessionStart?.(
      {},
      {
        cwd: "/repo",
        sessionManager: { getSessionId: () => "session" },
        ui: { setStatus() {} },
      },
    );
    await lifecycle.get("agent_start")?.();
    send.mockClear();

    await bashGate?.({ cwd: "/repo", command: "rm file" });
    expect(send).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({
        type: "report",
        record: expect.objectContaining({ state: "needs-permission" }),
      }),
    );

    await bashGateResolved?.({ cwd: "/repo", command: "rm file" });
    expect(send).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({
        type: "report",
        record: expect.objectContaining({ state: "working" }),
      }),
    );

    autoModeEnabled = true;
    send.mockClear();
    await bashGate?.({ cwd: "/repo", command: "rm file" });

    expect(send).not.toHaveBeenCalled();
  } finally {
    await sessionShutdown?.({ reason: "quit" });
  }
});
