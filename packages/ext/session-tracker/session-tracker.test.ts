import { expect, test } from "vitest";

import { createSessionTrackerRuntime } from "./index.js";

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
