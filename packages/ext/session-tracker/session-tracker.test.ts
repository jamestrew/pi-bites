import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import {
  colorizeSessionTrackerFooter,
  createSessionTrackerFooterRuntime,
  createSessionTrackerRuntime,
  defaultTrackerFooterOptions,
  defaultTrackerRuntimeOptions,
  formatPaneRecordLabel,
  requestSessionTracker,
  formatSessionTrackerFooter,
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
  ]);

  expect(records.map((record) => record.paneId)).toEqual(["%1", "%2", "%3"]);
  expect(records.map(formatPaneRecordLabel)).toEqual([
    "needs-permission · blocked · %1",
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
  await timer?.();

  expect(intervalMs).toBe(1_000);
  expect(statuses).toEqual([
    ["session-tracker", "pi-sessions: 1 · 1 working"],
    ["session-tracker", undefined],
  ]);
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
  await timer?.();
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
