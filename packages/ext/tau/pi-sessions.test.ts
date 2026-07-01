import { expect, test } from "vitest";

import { handlePiSessionsCommand, paneRecordToPiSession } from "./pi-sessions.js";
import { orderPiSessions, piSessionLabel } from "./pi-sessions-model.js";
import type { TauDashboardSession } from "../../tau/index.js";

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

test("orders pi sessions by attention state before activity", () => {
  expect(
    orderPiSessions([
      session({ sessionId: "idle", state: "idle", activityAt: 400 }),
      session({ sessionId: "working", state: "working", activityAt: 300 }),
      session({ sessionId: "blocked-old", state: "needs-input", activityAt: 100 }),
      session({ sessionId: "blocked-new", state: "needs-permission", activityAt: 200 }),
    ]).map((item) => item.sessionId),
  ).toEqual(["blocked-new", "blocked-old", "working", "idle"]);
});

test("builds pi session labels with cwd basename, state, and title", () => {
  expect(
    piSessionLabel(
      session({
        sessionId: "abc123",
        cwd: "/tmp/pi-bites",
        state: "working",
        title: "Implement picker",
      }),
    ),
  ).toBe("pi-bites · working · Implement picker");
});

test("maps daemon pane records into pi session labels", () => {
  expect(
    piSessionLabel(
      paneRecordToPiSession({
        paneId: "%1",
        cwd: "/tmp/pi-bites",
        runtimeId: "runtime",
        seq: 1,
        state: "needs-permission",
        heartbeatAt: 123,
        sessionId: "abc123",
      }),
    ),
  ).toBe("pi-bites · needs-permission · %1");
});

test("shows a small message when daemon snapshot is unavailable", async () => {
  const notifications: string[] = [];
  await handlePiSessionsCommand(
    { ui: { notify: (message: string) => notifications.push(message) } } as never,
    async () => {
      throw new Error("no daemon");
    },
  );

  expect(notifications).toEqual(["Pi sessions snapshot is unavailable."]);
});
