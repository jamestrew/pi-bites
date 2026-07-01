import { expect, test } from "vitest";

import {
  createSessionTrackerFooterRuntime,
  createSessionTrackerRuntime,
  formatPaneRecordLabel,
  requestSessionTracker,
  formatSessionTrackerFooter,
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

test("starts daemon and retries a missing socket report once", async () => {
  const calls: unknown[] = [];
  const spawned: string[] = [];

  await expect(
    requestSessionTracker(
      "sock",
      { type: "snapshot" },
      {
        spawnDaemon: () => spawned.push("spawn"),
        send: async (_socketPath, request) => {
          calls.push(request);
          if (calls.length === 1) throw Object.assign(new Error("missing"), { code: "ENOENT" });
          return { ok: true, records: [] };
        },
      },
    ),
  ).resolves.toEqual({ ok: true, records: [] });

  expect(spawned).toEqual(["spawn"]);
  expect(calls).toHaveLength(2);
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

test("session tracker footer periodically reads snapshots and fails quietly", async () => {
  const statuses: unknown[] = [];
  let timer: (() => void) | undefined;
  let intervalMs: number | undefined;
  let fail = false;
  const runtime = createSessionTrackerFooterRuntime({
    socketPath: "sock",
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
      send: async () => {
        throw new Error("boom");
      },
    },
  );

  expect(notices).toEqual([["Pi sessions are unavailable.", "warning"]]);
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

test("extension sends full-state heartbeats and releases on shutdown", async () => {
  const requests: unknown[] = [];
  let timer: (() => void) | undefined;
  const runtime = createSessionTrackerRuntime({
    paneId: "%1",
    runtimeId: "runtime-a",
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
    paneId: "%1",
    runtimeId: "runtime-a",
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
