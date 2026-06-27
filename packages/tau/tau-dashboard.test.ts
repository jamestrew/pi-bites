import { expect, test } from "vitest";

import { renderTauDashboard, type TauDashboardSession, type TauStatusLoadIssue } from "./index.js";

const NOW = 120_000;

function session(overrides: Partial<TauDashboardSession>): TauDashboardSession {
  return {
    sessionId: "session-a",
    sessionFile: "/home/me/.pi/sessions/session-a.jsonl",
    cwd: "/work/pi-bites",
    pid: 123,
    startedAt: 1_000,
    heartbeatAt: 100_000,
    lastEventAt: 100_000,
    activityAt: 100_000,
    sourceStatus: "idle",
    state: "idle",
    isLive: true,
    isStale: false,
    statusFile: "/home/me/.pi/agents/sessions/session-a/status.json",
    ...overrides,
  };
}

test("renders Tau product title, boundary copy, grouped states, and compact rows", () => {
  const lines = renderTauDashboard(
    [
      session({
        sessionId: "work-1",
        title: "Implement dashboard",
        state: "working",
        sourceStatus: "working",
        currentAction: "editing",
        currentTool: "write",
        activityAt: NOW - 90_000,
      }),
      session({ sessionId: "idle-1", state: "idle", sourceStatus: "idle" }),
      session({ sessionId: "stop-1", state: "stopped", sourceStatus: "stopped" }),
      session({ sessionId: "stale-1", state: "stale", sourceStatus: "working" }),
    ],
    [],
    { now: NOW, width: 120 },
  );

  expect(lines).toContain("Tau · Pi agents dashboard");
  expect(lines).toContain(
    "Tau observes sidecar status and opens sessions; native pi remains the session UI.",
  );
  expect(lines).toContain("Working (1)");
  expect(lines).toContain("Idle (1)");
  expect(lines).toContain("Stopped (1)");
  expect(lines).toContain("Stale (1)");
  expect(lines).toContain("  • Implement dashboard — editing · write · pi-bites · 1m ago");
});

test("renders uncommon statuses when present", () => {
  const lines = renderTauDashboard(
    [
      session({ sessionId: "perm", state: "needs-permission", sourceStatus: "needs-permission" }),
      session({ sessionId: "input", state: "needs-input", sourceStatus: "needs-input" }),
      session({
        sessionId: "failed",
        state: "failed",
        sourceStatus: "failed",
        lastError: "tool failed",
      }),
    ],
    [],
    { now: NOW, width: 120 },
  );

  expect(lines).toContain("Needs permission (1)");
  expect(lines).toContain("Needs input (1)");
  expect(lines).toContain("Failed (1)");
  expect(lines).toContain("  • failed — tool failed · pi-bites · 20s ago");
});

test("renders empty state and concise skipped-record warning", () => {
  const issues: TauStatusLoadIssue[] = [
    { kind: "invalid-json", statusFile: "/tmp/a", message: "bad json" },
    { kind: "missing-status", statusFile: "/tmp/b", message: "missing" },
  ];

  const lines = renderTauDashboard([], issues, { now: NOW, width: 120 });

  expect(lines).toContain(
    "Warning: skipped 2 Tau status records (1 invalid-json, 1 missing-status).",
  );
  expect(lines).toContain(
    "No Tau sidecar statuses were found yet. Start pi with Tau enabled to populate ~/.pi/agents/sessions.",
  );
});
