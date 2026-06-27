import { expect, test } from "vitest";

import {
  buildTauDashboardView,
  handleTauDashboardKey,
  moveTauDashboardSelection,
  reconcileTauDashboardSelection,
  renderTauDashboard,
  type TauDashboardSession,
  type TauStatusLoadIssue,
} from "./index.js";

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
  expect(lines).toContain("enter open · r refresh · q quit · ? help");
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

test("renders selected sessions distinctly and exposes concise help", () => {
  const lines = renderTauDashboard(
    [
      session({ sessionId: "work-1", title: "Implement dashboard", state: "working" }),
      session({ sessionId: "idle-1", title: "Resting", state: "idle" }),
    ],
    [],
    { now: NOW, width: 120, selectedSessionId: "idle-1", showHelp: true },
  );

  expect(lines).toContain("› • Resting — observing · pi-bites · 20s ago");
  expect(lines).toContain(
    "Help: ↑/↓ or j/k move selection; Enter opens the selected session in native pi; r refreshes; q quits; ? toggles help.",
  );
});

test("tracks selectable session rows without selecting headers or empty states", () => {
  const view = buildTauDashboardView([session({ sessionId: "work-1", state: "working" })], [], {
    now: NOW,
  });

  expect(view.selectableSessionIds).toEqual(["work-1"]);
  expect(view.rows.filter((row) => row.kind === "session").map((row) => row.sessionId)).toEqual([
    "work-1",
  ]);
  expect(
    view.rows.filter((row) => row.kind === "header" || row.kind === "empty"),
  ).not.toContainEqual(expect.objectContaining({ sessionId: expect.any(String) }));
});

test("reconciles and moves selection across refreshes", () => {
  const sessions = [
    session({ sessionId: "first", state: "working" }),
    session({ sessionId: "second", state: "idle" }),
    session({ sessionId: "third", state: "stopped" }),
  ];

  expect(reconcileTauDashboardSelection(sessions, { previousSessionId: "second" })).toEqual({
    selectedSessionId: "second",
    selectedIndex: 1,
  });
  expect(
    moveTauDashboardSelection(sessions, { selectedSessionId: "second", selectedIndex: 1 }, 1),
  ).toEqual({
    selectedSessionId: "third",
    selectedIndex: 2,
  });
  expect(
    reconcileTauDashboardSelection([sessions[0], sessions[2]], {
      previousSessionId: "second",
      previousIndex: 1,
    }),
  ).toEqual({
    selectedSessionId: "third",
    selectedIndex: 1,
  });
  expect(reconcileTauDashboardSelection([])).toEqual({ selectedIndex: -1 });
});

test("handles dashboard keys with a small controller", () => {
  const sessions = [
    session({ sessionId: "first", state: "working" }),
    session({ sessionId: "second", state: "idle" }),
  ];
  const baseState = {
    sessions,
    selection: reconcileTauDashboardSelection(sessions),
    showHelp: false,
    quitting: false,
  };

  const moved = handleTauDashboardKey(baseState, "down");
  expect(moved.effect).toBe("render");
  expect(moved.state.selection).toEqual({ selectedSessionId: "second", selectedIndex: 1 });

  const helped = handleTauDashboardKey(moved.state, "?");
  expect(helped.effect).toBe("render");
  expect(helped.state.showHelp).toBe(true);

  expect(handleTauDashboardKey(helped.state, "r").effect).toBe("refresh");
  expect(handleTauDashboardKey(helped.state, "enter").effect).toBe("open");
  expect(
    handleTauDashboardKey(
      { ...helped.state, selection: { selectedIndex: -1, selectedSessionId: undefined } },
      "enter",
    ).effect,
  ).toBe("render");
});

test("ignores keys after quit so q wins over pending refreshes", () => {
  const state = {
    sessions: [session({ sessionId: "first", state: "working" })],
    selection: { selectedSessionId: "first", selectedIndex: 0 },
    showHelp: false,
    quitting: false,
  };

  const quitting = handleTauDashboardKey(state, "q");
  expect(quitting.effect).toBe("quit");
  expect(quitting.state.quitting).toBe(true);

  const ignored = handleTauDashboardKey(quitting.state, "r");
  expect(ignored.effect).toBeUndefined();
  expect(ignored.state).toBe(quitting.state);
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
