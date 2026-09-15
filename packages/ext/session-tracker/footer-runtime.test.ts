import { expect, test, vi } from "vitest";
import { createSessionTrackerFooterRuntime, defaultTrackerFooterOptions } from "./index.js";

test("footer snapshots survive expired getters but cannot publish after replacement or stop", async () => {
  const pending: Array<(response: { ok: true; records: [] }) => void> = [];
  let tick: () => void = () => {};
  const runtime = createSessionTrackerFooterRuntime({
    ...defaultTrackerFooterOptions,
    socketPath: "sock",
    log: () => {},
    send: () => new Promise((resolve) => pending.push(resolve)),
    setInterval: ((callback: () => void) => {
      tick = callback;
      return { unref() {} } as ReturnType<typeof setInterval>;
    }) as typeof setInterval,
    clearInterval: (() => {}) as typeof clearInterval,
  });
  const publish = async () => {
    pending.shift()!({ ok: true, records: [] });
    await Promise.resolve();
  };
  const setStatus = vi.fn();
  const ui = { setStatus, theme: { fg: (_color: string, text: string) => text } };
  let stale = false;
  const getUi = vi.fn(() => {
    if (stale) throw new Error("stale ctx");
    return ui;
  });
  runtime.start({
    cwd: "/repo",
    get ui() {
      return getUi();
    },
  });
  stale = true;
  await publish();
  expect(setStatus).toHaveBeenCalledWith("session-tracker", undefined);
  expect(getUi).toHaveBeenCalledTimes(1);
  runtime.start({ cwd: "/repo", ui }); // Leave its initial snapshot in flight.
  runtime.start({ cwd: "/repo", ui });
  await publish();
  expect(setStatus).toHaveBeenCalledTimes(1);
  setStatus.mockImplementationOnce(() => {
    throw new Error("unavailable");
  });
  await publish();
  tick();
  await publish(); // A failed setter must not acknowledge the value.
  expect(setStatus).toHaveBeenCalledTimes(3);
  tick();
  await publish();
  expect(setStatus).toHaveBeenCalledTimes(3);
  runtime.start({ cwd: "/repo", ui });
  runtime.stop();
  await publish();
  expect(setStatus).toHaveBeenCalledTimes(3);
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
  await Promise.resolve(timer?.());
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
