import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import {
  requestTracker,
  SessionTracker,
  startSessionTrackerDaemon,
  type PaneRecord,
} from "./index.js";

function record(overrides: Partial<PaneRecord> = {}): PaneRecord {
  return {
    paneId: "%1",
    cwd: "/repo",
    runtimeId: "runtime-a",
    seq: 1,
    state: "idle",
    heartbeatAt: 1_000,
    ...overrides,
  };
}

test("release removes only the owning runtime pane record", async () => {
  const tracker = new SessionTracker({ tmuxPaneExists: () => true });
  await tracker.handle({ type: "report", record: record() });
  await tracker.handle({ type: "release", paneId: "%1", runtimeId: "other" });
  expect(tracker.snapshot()).toHaveLength(1);

  await tracker.handle({ type: "release", paneId: "%1", runtimeId: "runtime-a" });
  expect(tracker.snapshot()).toEqual([]);
});

test("stores current state by pane and ignores stale same-runtime sequences", async () => {
  const tracker = new SessionTracker({ now: () => 1_000, tmuxPaneExists: () => true });
  await tracker.handle({
    type: "report",
    record: record({ paneId: "%1", runtimeId: "old", seq: 3 }),
  });
  await tracker.handle({
    type: "report",
    record: record({ paneId: "%1", runtimeId: "old", seq: 2 }),
  });
  await tracker.handle({
    type: "report",
    record: record({ paneId: "%1", runtimeId: "new", seq: 1 }),
  });

  expect(tracker.snapshot()).toEqual([record({ paneId: "%1", runtimeId: "new", seq: 1 })]);
});

test("heartbeat refreshes current pane state", async () => {
  let now = 1_000;
  const tracker = new SessionTracker({ now: () => now, tmuxPaneExists: () => true });
  await tracker.handle({ type: "report", record: record({ seq: 1 }) });
  now = 9_000;
  await tracker.handle({ type: "heartbeat", record: record({ seq: 2, state: "working" }) });

  expect(tracker.snapshot()).toEqual([record({ seq: 2, state: "working", heartbeatAt: 9_000 })]);
});

test("prunes stale pane records", async () => {
  let now = 1_000;
  const tracker = new SessionTracker({
    now: () => now,
    staleTimeoutMs: 10,
    tmuxPaneExists: () => true,
  });
  await tracker.handle({ type: "report", record: record() });
  now = 1_011;

  await tracker.prune();
  expect(tracker.snapshot()).toEqual([]);
});

test("prunes records for missing tmux panes", async () => {
  const existing = new Set(["%2"]);
  const tracker = new SessionTracker({
    now: () => 1_000,
    tmuxPaneExists: (paneId) => existing.has(paneId),
  });
  await tracker.handle({ type: "report", record: record({ paneId: "%1" }) });
  await tracker.handle({ type: "report", record: record({ paneId: "%2" }) });

  await tracker.prune();
  expect(tracker.snapshot()).toEqual([record({ paneId: "%2" })]);
});

test("daemon ingests reports and returns snapshots over newline JSON", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-bites-tracker-"));
  const socketPath = join(dir, "tracker.sock");
  const server = await startSessionTrackerDaemon(
    socketPath,
    new SessionTracker({ now: () => 1_000, tmuxPaneExists: () => true }),
    {
      setInterval: (() => ({ unref() {} }) as ReturnType<typeof setInterval>) as typeof setInterval,
      clearInterval: (() => {}) as typeof clearInterval,
    },
  );

  try {
    await expect(
      requestTracker(socketPath, { type: "report", record: record({ sessionId: "session-1" }) }),
    ).resolves.toEqual({ ok: true });
    await expect(requestTracker(socketPath, { type: "snapshot" })).resolves.toEqual({
      ok: true,
      records: [record({ heartbeatAt: 1_000, sessionId: "session-1" })],
    });
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("daemon periodically prunes without a request", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-bites-tracker-"));
  const socketPath = join(dir, "tracker.sock");
  let prune: (() => void) | undefined;
  let now = 1_000;
  const tracker = new SessionTracker({
    now: () => now,
    staleTimeoutMs: 10,
    tmuxPaneExists: () => true,
  });
  const server = await startSessionTrackerDaemon(socketPath, tracker, {
    setInterval: ((callback: () => void) => {
      prune = callback;
      return { unref() {} } as ReturnType<typeof setInterval>;
    }) as typeof setInterval,
    clearInterval: (() => {}) as typeof clearInterval,
  });

  try {
    await tracker.handle({ type: "report", record: record() });
    now = 1_011;
    await prune?.();

    expect(tracker.snapshot()).toEqual([]);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("focuses a tracked existing pane by tmux pane id", async () => {
  const calls: string[][] = [];
  const tracker = new SessionTracker({
    tmuxPaneExists: () => true,
    tmuxRunner: (args) => {
      calls.push(args);
    },
  });
  await tracker.handle({ type: "report", record: record({ paneId: "%7" }) });

  await expect(tracker.handle({ type: "focus_pane", paneId: "%7" })).resolves.toEqual({ ok: true });
  expect(calls).toEqual([["switch-client", "-t", "%7"]]);
});

test("focus returns not-found for unknown panes", async () => {
  const tracker = new SessionTracker({ tmuxPaneExists: () => true });

  await expect(tracker.handle({ type: "focus_pane", paneId: "%404" })).resolves.toEqual({
    ok: false,
    error: "not-found",
  });
});

test("focus prunes panes that vanish before selection", async () => {
  const tracker = new SessionTracker({ tmuxPaneExists: () => false });
  await tracker.handle({ type: "report", record: record({ paneId: "%9" }) });

  await expect(tracker.handle({ type: "focus_pane", paneId: "%9" })).resolves.toEqual({
    ok: false,
    error: "not-found",
  });
  expect(tracker.snapshot()).toEqual([]);
});

test("focus reports tmux command failures without deleting live panes", async () => {
  const tracker = new SessionTracker({
    now: () => 1_000,
    tmuxPaneExists: () => true,
    tmuxRunner: () => {
      throw new Error("tmux failed");
    },
  });
  await tracker.handle({ type: "report", record: record({ paneId: "%3" }) });

  const response = await tracker.handle({ type: "focus_pane", paneId: "%3" });

  expect(response.ok).toBe(false);
  expect(response.error).toContain("tmux failed");
  expect(tracker.snapshot()).toEqual([record({ paneId: "%3" })]);
});
