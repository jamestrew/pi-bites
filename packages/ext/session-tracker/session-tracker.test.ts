import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEndEvent, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import registerSessionTracker, {
  colorizeSessionTrackerFooter,
  createNeedsInputLifecycle,
  createSessionTrackerFooterRuntime,
  createSessionTrackerRuntime,
  defaultTrackerFooterOptions,
  defaultTrackerRuntimeOptions,
  formatPaneRecordLabel,
  requestSessionTracker,
  formatSessionTrackerFooter,
  inferNeedsInputFromAssistantText,
  parseNeedsInputClassification,
  restartPiSessionsDaemon,
  runPiSessionsNext,
  runPiSessionsPicker,
  sortPaneRecordsForPicker,
} from "./index.js";
test("sorts and labels pi-sessions picker records", () => {
  const records = sortPaneRecordsForPicker([
    { paneId: "%3", cwd: "/work/idle", runtimeId: "r", seq: 1, state: "idle", heartbeatAt: 1 },
    {
      paneId: "%1",
      cwd: "/work/blocked",
      runtimeId: "r",
      seq: 1,
      state: "needs-permission",
      heartbeatAt: 1,
    },
    { paneId: "%2", cwd: "/work/app", runtimeId: "r", seq: 1, state: "working", heartbeatAt: 1 },
    {
      paneId: "%4",
      cwd: "/work/input",
      runtimeId: "r",
      seq: 1,
      state: "needs-input",
      heartbeatAt: 1,
    },
  ]);

  expect(records.map((record) => record.paneId)).toEqual(["%1", "%4", "%2", "%3"]);
  expect(records.map(formatPaneRecordLabel)).toEqual([
    "needs-permission · blocked · %1",
    "needs-input · input · %4",
    "working · app · %2",
    "idle · idle · %3",
  ]);
});

test("starts daemon and resends a missing socket report once ready", async () => {
  const calls: unknown[] = [];
  const events: string[] = [];

  await expect(
    requestSessionTracker(
      "sock-missing",
      { type: "snapshot" },
      {
        log: () => {},
        spawnDaemon: () => events.push("spawn"),
        awaitDaemonReady: async () => {
          events.push("ready");
        },
        send: async (_socketPath, request) => {
          calls.push(request);
          if (calls.length === 1) throw Object.assign(new Error("missing"), { code: "ENOENT" });
          return { ok: true, records: [] };
        },
      },
    ),
  ).resolves.toEqual({ ok: true, records: [] });

  expect(events).toEqual(["spawn", "ready"]);
  expect(calls).toHaveLength(2);
});

test("treats ECONNREFUSED like a missing socket", async () => {
  const calls: unknown[] = [];
  const spawned: string[] = [];

  await expect(
    requestSessionTracker(
      "sock-refused",
      { type: "snapshot" },
      {
        spawnDaemon: () => spawned.push("spawn"),
        awaitDaemonReady: async () => {},
        log: () => {},
        send: async (_socketPath, request) => {
          calls.push(request);
          if (calls.length === 1)
            throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
          return { ok: true, records: [] };
        },
      },
    ),
  ).resolves.toEqual({ ok: true, records: [] });

  expect(spawned).toEqual(["spawn"]);
  expect(calls).toHaveLength(2);
});

test("rejects when the daemon never becomes ready", async () => {
  let sends = 0;
  let spawns = 0;

  await expect(
    requestSessionTracker(
      "sock-dead",
      { type: "snapshot" },
      {
        spawnDaemon: () => {
          spawns++;
        },
        awaitDaemonReady: async () => {
          throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
        },
        log: () => {},
        send: async () => {
          sends++;
          throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
        },
      },
    ),
  ).rejects.toMatchObject({ code: "ECONNREFUSED" });

  expect(spawns).toBe(1);
  expect(sends).toBe(1);
});

test("backs off repeated daemon starts after startup failure", async () => {
  let spawns = 0;
  let sends = 0;
  const options = {
    spawnDaemon: () => {
      spawns++;
    },
    awaitDaemonReady: async () => {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
    send: async () => {
      sends++;
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
    log: () => {},
  };

  await expect(
    requestSessionTracker("sock-startup-fails", { type: "snapshot" }, options),
  ).rejects.toMatchObject({ code: "ENOENT" });
  await expect(
    requestSessionTracker("sock-startup-fails", { type: "snapshot" }, options),
  ).rejects.toMatchObject({ code: "ENOENT" });

  expect(spawns).toBe(1);
  expect(sends).toBe(2);
});

test("rejects when sends keep failing after the daemon is ready", async () => {
  let sends = 0;

  await expect(
    requestSessionTracker(
      "sock-flaky",
      { type: "snapshot" },
      {
        spawnDaemon: () => {},
        awaitDaemonReady: async () => {},
        log: () => {},
        send: async () => {
          sends++;
          throw Object.assign(new Error("missing"), { code: "ENOENT" });
        },
      },
    ),
  ).rejects.toMatchObject({ code: "ENOENT" });

  expect(sends).toBe(2);
});

test("rethrows a non-retryable error without spawning", async () => {
  let sends = 0;
  let spawns = 0;

  await expect(
    requestSessionTracker(
      "sock-denied",
      { type: "snapshot" },
      {
        spawnDaemon: () => {
          spawns++;
        },
        awaitDaemonReady: async () => {},
        log: () => {},
        send: async () => {
          sends++;
          throw Object.assign(new Error("denied"), { code: "EACCES" });
        },
      },
    ),
  ).rejects.toMatchObject({ code: "EACCES" });

  expect(spawns).toBe(0);
  expect(sends).toBe(1);
});

test("rethrows a non-retryable error after respawn", async () => {
  let sends = 0;

  await expect(
    requestSessionTracker(
      "sock-denied-late",
      { type: "snapshot" },
      {
        spawnDaemon: () => {},
        awaitDaemonReady: async () => {},
        log: () => {},
        send: async () => {
          sends++;
          if (sends === 1) throw Object.assign(new Error("missing"), { code: "ENOENT" });
          throw Object.assign(new Error("denied"), { code: "EACCES" });
        },
      },
    ),
  ).rejects.toMatchObject({ code: "EACCES" });

  expect(sends).toBe(2);
});

test("coalesces concurrent daemon spawns for the same socket", async () => {
  let spawns = 0;
  let ready = false;
  const options = {
    spawnDaemon: () => {
      spawns++;
    },
    awaitDaemonReady: async () => {
      await Promise.resolve();
      ready = true;
    },
    log: () => {},
    send: async () => {
      if (!ready) throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
      return { ok: true };
    },
  };

  await expect(
    Promise.all([
      requestSessionTracker("sock-coalesce", { type: "snapshot" }, options),
      requestSessionTracker("sock-coalesce", { type: "snapshot" }, options),
    ]),
  ).resolves.toEqual([{ ok: true }, { ok: true }]);

  expect(spawns).toBe(1);
});

test("default awaitDaemonReady polls a stale socket until it accepts connections", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-tracker-"));
  const socketPath = join(dir, "tracker.sock");
  writeFileSync(socketPath, "");
  const server = createServer();
  const timer = setTimeout(() => {
    unlinkSync(socketPath);
    server.listen(socketPath);
  }, 60);

  try {
    await defaultTrackerRuntimeOptions.awaitDaemonReady(socketPath);
  } finally {
    clearTimeout(timer);
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("formats session tracker footer with blocked panes first", () => {
  expect(
    formatSessionTrackerFooter([
      { paneId: "%3", cwd: "/work/idle", runtimeId: "r", seq: 1, state: "idle", heartbeatAt: 1 },
      {
        paneId: "%1",
        cwd: "/work/blocked",
        runtimeId: "r",
        seq: 1,
        state: "needs-permission",
        heartbeatAt: 1,
      },
      {
        paneId: "%2",
        cwd: "/work/app",
        runtimeId: "r",
        seq: 1,
        state: "working",
        heartbeatAt: 1,
      },
    ]),
  ).toBe("pi-sessions: 3 · blocked blocked · 1 working · 1 idle");
});

test("formats and suppresses needs-input footer attention", () => {
  const records = [
    {
      paneId: "%1",
      cwd: "/work/app",
      runtimeId: "r",
      seq: 1,
      state: "needs-input" as const,
      heartbeatAt: 1,
    },
    {
      paneId: "%2",
      cwd: "/work/api",
      runtimeId: "r",
      seq: 1,
      state: "needs-input" as const,
      heartbeatAt: 1,
    },
  ];
  expect(formatSessionTrackerFooter(records)).toBe("pi-sessions: 2 · needs input api +1");
  expect(formatSessionTrackerFooter(records, "%1")).toBe("pi-sessions: 2 · needs input api");
});

test("parses idle and rejects malformed classifier output", () => {
  expect(parseNeedsInputClassification("IDLE")).toBe(false);
  expect(parseNeedsInputClassification(" needs_input ")).toBe(true);
  expect(() => parseNeedsInputClassification("maybe")).toThrow(
    "unexpected needs-input classifier response: MAYBE",
  );
});

test("asks the small model to classify rather than answer the assistant message", async () => {
  const model = { provider: "test", id: "small" };
  const ctx = {
    model,
    modelRegistry: {
      getAll: () => [model],
      getAvailable: () => [model],
      find: () => model,
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test" }),
    },
  } as unknown as ExtensionContext;

  await expect(
    inferNeedsInputFromAssistantText(
      "Which should take priority when both occur?",
      ctx,
      { smallModel: { model: "test/small" } },
      async (_model, request) =>
        ({
          role: "assistant",
          content: [
            {
              type: "text",
              text: (
                (request.messages[0]?.content ?? []) as { type: string; text: string }[]
              )[0]?.text.startsWith("Classify the assistant message")
                ? "NEEDS_INPUT"
                : "Permission should take priority.",
            },
          ],
          stopReason: "stop",
        }) as never,
    ),
  ).resolves.toBe(true);
});

function agentEnd(text: string): AgentEndEvent {
  return {
    type: "agent_end",
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text }],
        api: "test",
        provider: "test",
        model: "test",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 1,
      },
    ],
  };
}

test("does not classify intermediate agent_end and invalidates in-flight results", async () => {
  const states: string[] = [];
  let finishClassification: ((needsInput: boolean) => void) | undefined;
  const lifecycle = createNeedsInputLifecycle(
    async (state) => void states.push(state),
    () => new Promise<boolean>((resolve) => (finishClassification = resolve)),
    () => {},
  );
  const ctx = {} as ExtensionContext;

  await lifecycle.agentStart();
  lifecycle.agentEnd(agentEnd("Need a choice"));
  expect(states).toEqual(["working"]);

  const settled = lifecycle.agentSettled(ctx);
  await lifecycle.agentStart();
  finishClassification?.(true);
  await settled;

  expect(states).toEqual(["working", "working"]);
});

test("classifier failure falls back to idle after settling", async () => {
  const states: string[] = [];
  const lifecycle = createNeedsInputLifecycle(
    async (state) => void states.push(state),
    async () => {
      throw new Error("malformed output");
    },
    () => {},
  );

  lifecycle.agentEnd(agentEnd("Done"));
  await lifecycle.agentSettled({} as ExtensionContext);
  expect(states).toEqual(["idle"]);
});

test("formats session tracker footer counts without blocked panes", () => {
  expect(
    formatSessionTrackerFooter([
      { paneId: "%1", cwd: "/work/a", runtimeId: "r", seq: 1, state: "idle", heartbeatAt: 1 },
      { paneId: "%2", cwd: "/work/b", runtimeId: "r", seq: 1, state: "working", heartbeatAt: 1 },
    ]),
  ).toBe("pi-sessions: 2 · 1 working · 1 idle");
});

test("hides blocked footer entry for the focused pane", () => {
  expect(
    formatSessionTrackerFooter(
      [
        {
          paneId: "%1",
          cwd: "/work/blocked",
          runtimeId: "r",
          seq: 1,
          state: "needs-permission",
          heartbeatAt: 1,
        },
        {
          paneId: "%2",
          cwd: "/work/app",
          runtimeId: "r",
          seq: 1,
          state: "working",
          heartbeatAt: 1,
        },
      ],
      "%1",
    ),
  ).toBe("pi-sessions: 2 · 1 working");
});

test("colors pi-sessions footer dim with blocked warning", () => {
  const theme = {
    fg: (color: "dim" | "error", text: string) => `<${color}>${text}</${color}>`,
    getFgAnsi: (color: "dim") => `<${color}>`,
  };

  expect(colorizeSessionTrackerFooter("pi-sessions: 2 · blocked repo · 1 idle", theme)).toBe(
    "<dim>pi-sessions: 2 · </dim><error>blocked repo</error><dim><dim> · 1 idle</dim>",
  );
  expect(
    colorizeSessionTrackerFooter(
      "pi-sessions: 3 · blocked repo · needs input other · 1 idle",
      theme,
    ),
  ).toBe(
    "<dim>pi-sessions: 3 · </dim><error>blocked repo</error><dim><dim> · </dim><error>needs input other</error><dim><dim> · 1 idle</dim>",
  );
});

test("session tracker footer periodically reads snapshots and fails quietly", async () => {
  const statuses: unknown[] = [];
  let timer: (() => void) | undefined;
  let intervalMs: number | undefined;
  let fail = false;
  const runtime = createSessionTrackerFooterRuntime({
    ...defaultTrackerFooterOptions,
    socketPath: "sock",
    log: () => {},
    send: async (_socketPath, request) => {
      if (fail) throw new Error("down");
      expect(request).toEqual({ type: "snapshot" });
      return {
        ok: true,
        records: [
          {
            paneId: "%1",
            cwd: "/work/repo",
            runtimeId: "r",
            seq: 1,
            state: "working",
            heartbeatAt: 1,
          },
        ],
      };
    },
    setInterval: ((callback: () => void, ms?: number) => {
      timer = callback;
      intervalMs = ms;
      return { unref() {} } as ReturnType<typeof setInterval>;
    }) as typeof setInterval,
    clearInterval: (() => {}) as typeof clearInterval,
  });

  runtime.start({ cwd: "/work/repo", ui: { setStatus: (...args) => statuses.push(args) } });
  await Promise.resolve();
  fail = true;
  await Promise.resolve(timer?.());

  expect(intervalMs).toBe(1_000);
  expect(statuses).toEqual([
    ["session-tracker", "pi-sessions: 1 · 1 working"],
    ["session-tracker", undefined],
  ]);
});

test("session tracker footer ignores stale ctx status updates", async () => {
  const runtime = createSessionTrackerFooterRuntime({
    ...defaultTrackerFooterOptions,
    socketPath: "sock",
    log: () => {},
    send: async () => ({ ok: true, records: [] }),
    setInterval: ((callback: () => void) => {
      void callback;
      return { unref() {} } as ReturnType<typeof setInterval>;
    }) as typeof setInterval,
    clearInterval: (() => {}) as typeof clearInterval,
  });

  expect(() => {
    runtime.start({
      cwd: "/repo",
      get ui(): never {
        throw new Error("stale ctx");
      },
    });
    runtime.stop({
      get ui(): never {
        throw new Error("stale ctx");
      },
    });
  }).not.toThrow();
  await Promise.resolve();
});

test("logs repeated client failures once and logs recovery", async () => {
  const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  const lines: string[] = [];
  let fail = true;
  let timer: (() => void) | undefined;
  const runtime = createSessionTrackerFooterRuntime({
    ...defaultTrackerFooterOptions,
    socketPath: "sock-failure-log",
    log: (_socketPath, message) => lines.push(message),
    send: async () => {
      if (fail) throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
      return { ok: true, records: [] };
    },
    setInterval: ((callback: () => void) => {
      timer = callback;
      return { unref() {} } as ReturnType<typeof setInterval>;
    }) as typeof setInterval,
    clearInterval: (() => {}) as typeof clearInterval,
  });

  runtime.start({ cwd: "/repo", ui: { setStatus: () => {} } });
  await flush();
  timer?.();
  await flush();
  fail = false;
  timer?.();
  await flush();

  expect(lines).toEqual(["client footer snapshot failed", "client footer snapshot recovered"]);
});

test("pi-sessions focuses the selected pane", async () => {
  const requests: unknown[] = [];
  await runPiSessionsPicker(
    {
      ui: {
        notify() {},
        select: async () => "working · repo · %2",
      },
    },
    {
      socketPath: "sock",
      spawnDaemon: () => {},
      awaitDaemonReady: async () => {},
      log: () => {},
      send: async (_socketPath, request) => {
        requests.push(request);
        if (request.type === "snapshot")
          return {
            ok: true,
            records: [
              {
                paneId: "%2",
                cwd: "/work/repo",
                runtimeId: "r",
                seq: 1,
                state: "working",
                heartbeatAt: 1,
              },
            ],
          };
        return { ok: true };
      },
    },
  );
  expect(requests).toEqual([{ type: "snapshot" }, { type: "focus_pane", paneId: "%2" }]);
});
test("pi-sessions picker cancellation does not focus a pane", async () => {
  const requests: unknown[] = [];
  const notices: unknown[] = [];
  await runPiSessionsPicker(
    {
      ui: {
        notify: (message, level) => notices.push([message, level]),
        select: async () => undefined,
      },
    },
    {
      socketPath: "sock",
      spawnDaemon: () => {},
      awaitDaemonReady: async () => {},
      log: () => {},
      send: async (_socketPath, request) => {
        requests.push(request);
        return request.type === "snapshot"
          ? {
              ok: true,
              records: [
                {
                  paneId: "%2",
                  cwd: "/work/repo",
                  runtimeId: "r",
                  seq: 1,
                  state: "working",
                  heartbeatAt: 1,
                },
              ],
            }
          : { ok: true };
      },
    },
  );
  expect(requests).toEqual([{ type: "snapshot" }]);
  expect(notices).toEqual([]);
});
test("pi-sessions shows a small warning for stale panes", async () => {
  const notices: unknown[] = [];
  await runPiSessionsPicker(
    {
      ui: {
        notify: (message, level) => notices.push([message, level]),
        select: async () => "idle · repo · %1",
      },
    },
    {
      socketPath: "sock",
      spawnDaemon: () => {},
      awaitDaemonReady: async () => {},
      log: () => {},
      send: async (_socketPath, request) =>
        request.type === "snapshot"
          ? {
              ok: true,
              records: [
                {
                  paneId: "%1",
                  cwd: "/work/repo",
                  runtimeId: "r",
                  seq: 1,
                  state: "idle",
                  heartbeatAt: 1,
                },
              ],
            }
          : { ok: false, error: "not-found" },
    },
  );

  expect(notices).toEqual([["That tmux pane disappeared. Refresh and try again.", "warning"]]);
});
test("pi-sessions shows unavailable when snapshot fails", async () => {
  const notices: unknown[] = [];
  await runPiSessionsPicker(
    {
      ui: {
        notify: (message, level) => notices.push([message, level]),
        select: async () => undefined,
      },
    },
    {
      socketPath: "sock",
      spawnDaemon: () => {},
      awaitDaemonReady: async () => {},
      log: () => {},
      send: async () => {
        throw new Error("boom");
      },
    },
  );

  expect(notices).toEqual([["Pi sessions are unavailable.", "warning"]]);
});
test("restarts the pi-sessions daemon", async () => {
  const requests: unknown[] = [];
  const spawned: string[] = [];
  await restartPiSessionsDaemon({
    socketPath: "sock",
    send: async (_socketPath, request) => {
      requests.push(request);
      return { ok: true };
    },
    spawnDaemon: () => spawned.push("spawn"),
  });

  expect(requests).toEqual([{ type: "shutdown" }]);
  expect(spawned).toEqual(["spawn"]);
});
test("pi-sessions shortcut focuses the next pane", async () => {
  const requests: unknown[] = [];
  await runPiSessionsNext(
    { ui: { notify() {}, select: async () => undefined } },
    {
      socketPath: "sock",
      paneId: "%2",
      spawnDaemon: () => {},
      awaitDaemonReady: async () => {},
      log: () => {},
      send: async (_socketPath, request) => {
        requests.push(request);
        return { ok: true };
      },
    },
  );

  expect(requests).toEqual([{ type: "focus_next", currentPaneId: "%2" }]);
});
test("pi-sessions shows focus errors", async () => {
  const notices: unknown[] = [];
  await runPiSessionsPicker(
    {
      ui: {
        notify: (message, level) => notices.push([message, level]),
        select: async () => "idle · repo · %1",
      },
    },
    {
      socketPath: "sock",
      spawnDaemon: () => {},
      awaitDaemonReady: async () => {},
      log: () => {},
      send: async (_socketPath, request) =>
        request.type === "snapshot"
          ? {
              ok: true,
              records: [
                {
                  paneId: "%1",
                  cwd: "/work/repo",
                  runtimeId: "r",
                  seq: 1,
                  state: "idle",
                  heartbeatAt: 1,
                },
              ],
            }
          : { ok: false, error: "tmux failed" },
    },
  );

  expect(notices).toEqual([["Failed to focus tmux pane: tmux failed", "error"]]);
});
test("extension waits for agent_settled before classifying", () => {
  const handlers = new Map<string, unknown>();

  registerSessionTracker({
    on: (event: string, handler: unknown) => {
      handlers.set(event, handler);
    },
    events: { on() {} },
    registerCommand() {},
    registerShortcut() {},
  } as never);

  expect(handlers.has("agent_end")).toBe(true);
  expect(handlers.has("agent_settled")).toBe(true);
  expect(handlers.has("turn_end")).toBe(false);
});

test("extension tracking failures are best-effort and shutdown does not respawn", async () => {
  let sends = 0;
  let spawns = 0;
  const runtime = createSessionTrackerRuntime({
    ...defaultTrackerRuntimeOptions,
    runtimeId: "runtime-a",
    socketPath: "sock-best-effort",
    paneId: "%1",
    log: () => {},
    send: async () => {
      sends++;
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
    spawnDaemon: () => {
      spawns++;
    },
    awaitDaemonReady: async () => {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
    setInterval: (() => ({ unref() {} }) as ReturnType<typeof setInterval>) as typeof setInterval,
    clearInterval: (() => {}) as typeof clearInterval,
  });

  await expect(runtime.start({ cwd: "/repo" })).resolves.toBeUndefined();
  await expect(runtime.stop(true)).resolves.toBeUndefined();

  expect(spawns).toBe(1);
  expect(sends).toBe(2);
});

test("extension sends full-state heartbeats and releases on shutdown", async () => {
  const requests: unknown[] = [];
  let timer: (() => void) | undefined;
  const runtime = createSessionTrackerRuntime({
    ...defaultTrackerRuntimeOptions,
    runtimeId: "runtime-a",
    socketPath: "sock",
    paneId: "%1",
    now: () => 1_000,
    send: async (_socketPath, request) => {
      requests.push(request);
      return { ok: true };
    },
    setInterval: ((callback: () => void) => {
      timer = callback;
      return { unref() {} } as ReturnType<typeof setInterval>;
    }) as typeof setInterval,
    clearInterval: (() => {}) as typeof clearInterval,
  });

  await runtime.start({ cwd: "/repo", sessionManager: { getSessionId: () => "session-1" } });
  await runtime.setState("working");
  await Promise.resolve(timer?.());
  await runtime.stop(true);

  expect(requests).toEqual([
    {
      type: "report",
      record: {
        paneId: "%1",
        cwd: "/repo",
        runtimeId: "runtime-a",
        seq: 1,
        state: "idle",
        heartbeatAt: 1_000,
        sessionId: "session-1",
      },
    },
    {
      type: "report",
      record: {
        paneId: "%1",
        cwd: "/repo",
        runtimeId: "runtime-a",
        seq: 2,
        state: "working",
        heartbeatAt: 1_000,
        sessionId: "session-1",
      },
    },
    {
      type: "heartbeat",
      record: {
        paneId: "%1",
        cwd: "/repo",
        runtimeId: "runtime-a",
        seq: 3,
        state: "working",
        heartbeatAt: 1_000,
        sessionId: "session-1",
      },
    },
    { type: "release", paneId: "%1", runtimeId: "runtime-a" },
  ]);
});

test("extension does not release on non-quit shutdown", async () => {
  const requests: unknown[] = [];
  const runtime = createSessionTrackerRuntime({
    ...defaultTrackerRuntimeOptions,
    runtimeId: "runtime-a",
    socketPath: "sock",
    paneId: "%1",
    send: async (_socketPath, request) => {
      requests.push(request);
      return { ok: true };
    },
    setInterval: (() => ({ unref() {} }) as ReturnType<typeof setInterval>) as typeof setInterval,
    clearInterval: (() => {}) as typeof clearInterval,
  });

  await runtime.start({ cwd: "/repo" });
  await runtime.stop(false);

  expect(requests).toHaveLength(1);
});

test("heartbeat disarms instead of throwing when ctx goes stale", async () => {
  const requests: unknown[] = [];
  let timerCallback: (() => void) | undefined;
  let cleared = 0;
  let stale = false;
  const runtime = createSessionTrackerRuntime({
    ...defaultTrackerRuntimeOptions,
    runtimeId: "runtime-a",
    socketPath: "sock",
    paneId: "%1",
    log: () => {},
    send: async (_socketPath, request) => {
      requests.push(request);
      return { ok: true };
    },
    setInterval: ((callback: () => void) => {
      timerCallback = callback;
      return { unref() {} } as ReturnType<typeof setInterval>;
    }) as typeof setInterval,
    clearInterval: (() => {
      cleared++;
    }) as typeof clearInterval,
  });

  await runtime.start({
    get cwd(): string {
      if (stale)
        throw new Error("This extension ctx is stale after session replacement or reload.");
      return "/repo";
    },
  });
  stale = true;

  expect(() => timerCallback?.()).not.toThrow();
  await Promise.resolve();

  expect(cleared).toBe(1);
  expect(requests).toHaveLength(1);

  timerCallback?.();
  await Promise.resolve();
  expect(requests).toHaveLength(1);
});

test("stop during the initial report does not leak a heartbeat timer", async () => {
  let resolveSend: ((response: { ok: boolean }) => void) | undefined;
  let intervals = 0;
  const runtime = createSessionTrackerRuntime({
    ...defaultTrackerRuntimeOptions,
    runtimeId: "runtime-a",
    socketPath: "sock",
    paneId: "%1",
    log: () => {},
    send: (() =>
      new Promise((resolve) => {
        resolveSend = resolve;
      })) as typeof defaultTrackerRuntimeOptions.send,
    setInterval: ((callback: () => void) => {
      void callback;
      intervals++;
      return { unref() {} } as ReturnType<typeof setInterval>;
    }) as typeof setInterval,
    clearInterval: (() => {}) as typeof clearInterval,
  });

  const started = runtime.start({ cwd: "/repo" });
  await runtime.stop(false);
  resolveSend?.({ ok: true });
  await started;

  expect(intervals).toBe(0);
});
