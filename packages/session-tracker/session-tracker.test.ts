import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { SessionTracker, startSessionTrackerDaemon, type PaneRecord } from "./index.js";

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
