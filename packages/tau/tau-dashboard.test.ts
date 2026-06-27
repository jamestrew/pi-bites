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
    sessionFileExists: true,
    statusFile: "/home/me/.pi/agents/sessions/session-a/status.json",
    ...overrides,
  };
}

test("renders compact Tau shell, boundary copy, grouped states, and compact rows", () => {
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

  expect(lines).toContain("▐▛███▜▌  Tau · Pi agents");
  expect(lines).toContain("  ▘▘ ▝▝   1 working · 1 idle · 1 stopped · 1 stale");
  expect(lines).toContain("          observes Pi sessions · enter opens native pi");
  expect(lines.filter((line) => ["Working", "Idle", "Stopped", "Stale"].includes(line))).toEqual([
    "Working",
    "Idle",
    "Stopped",
    "Stale",
  ]);
  expect(lines).toContain("  • stop-1 — stopped · pi-bites · 20s ago");
  expect(lines).toContain("  • stale-1 — stale · pi-bites · 20s ago");
  expect(lines).toContain("  • Implement dashboard — editing · write · pi-bites · 1m ago");
  expect(lines).toContain("enter open · ↑/↓ move · q quit · ? help");
  expect(lines).not.toContain("enter open · r refresh · q quit · ? help");
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

  expect(lines).toContain("Needs permission");
  expect(lines).toContain("Needs input");
  expect(lines).toContain("Failed");
  expect(lines).toContain("  • failed — tool failed · pi-bites · 20s ago");
});

test("surfaces lastError for failed sidecars even when freshness metadata is stale", () => {
  const lines = renderTauDashboard(
    [
      session({
        sessionId: "failed-stale",
        state: "stale",
        sourceStatus: "failed",
        lastError: "tool failed before heartbeat expired",
        isLive: false,
        isStale: true,
      }),
    ],
    [],
    { now: NOW, width: 120 },
  );

  expect(lines).toContain("Stale");
  expect(lines).toContain(
    "  • failed-stale — tool failed before heartbeat expired · pi-bites · 20s ago",
  );
});

test("omits missing session file targets safely", () => {
  const view = buildTauDashboardView(
    [
      session({ sessionId: "missing", sessionFileExists: false }),
      session({ sessionId: "existing" }),
    ],
    [],
    { now: NOW, width: 120, selectedSessionId: "missing" },
  );

  expect(view.lines.join("\n")).not.toContain("missing");
  expect(view.rows.filter((row) => row.kind === "session").map((row) => row.sessionId)).toEqual([
    "existing",
  ]);
  expect(view.selectableSessionIds).toEqual(["existing"]);
  expect(view.lines).toContain("  • existing — observing · pi-bites · 20s ago");
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
    "Help: ↑/↓ or j/k move selection; Enter opens the selected session in native pi; q quits; ? toggles help.",
  );
  expect(lines.join("\n")).not.toContain("refresh");
});

test("tracks selectable session rows in visual group order without selecting headers or empty states", () => {
  const view = buildTauDashboardView(
    [
      session({ sessionId: "idle-1", state: "idle" }),
      session({ sessionId: "stop-1", state: "stopped" }),
      session({ sessionId: "work-1", state: "working" }),
    ],
    [],
    { now: NOW },
  );

  expect(view.selectableSessionIds).toEqual(["work-1", "idle-1", "stop-1"]);
  expect(view.rows.filter((row) => row.kind === "session").map((row) => row.sessionId)).toEqual([
    "work-1",
    "idle-1",
    "stop-1",
  ]);
  expect(view.rows.filter((row) => row.kind === "header").map((row) => row.line)).toEqual([
    "Working",
    "Idle",
    "Stopped",
  ]);
  expect(view.rows.some((row) => row.line === "  none")).toBe(false);
  expect(
    view.rows.filter((row) => row.kind === "header" || row.kind === "empty"),
  ).not.toContainEqual(expect.objectContaining({ sessionId: expect.any(String) }));
});

test("reconciles and moves selection across refreshes in visual group order", () => {
  const sessions = [
    session({ sessionId: "second", state: "idle" }),
    session({ sessionId: "third", state: "stopped" }),
    session({ sessionId: "first", state: "working" }),
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
    reconcileTauDashboardSelection([sessions[1], sessions[2]], {
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
  expect(lines).toContain("No Tau sessions yet.");
});
