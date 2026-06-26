import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { loadTauDashboardSessions, type TauStatusRecord } from "./index.js";

async function writeStatus(root: string, sessionId: string, status: unknown): Promise<void> {
  const dir = join(root, "sessions", sessionId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "status.json"), JSON.stringify(status), "utf-8");
}

function status(overrides: Partial<TauStatusRecord> = {}): TauStatusRecord {
  return {
    schemaVersion: 1,
    sessionId: "session-a",
    sessionFile: "/home/me/.pi/agent/sessions/repo/session-a.jsonl",
    cwd: "/repo",
    pid: 111,
    startedAt: 1_000,
    heartbeatAt: 10_000,
    lastEventAt: 9_000,
    status: "idle",
    ...overrides,
  };
}

test("loads valid Tau status sidecars into dashboard sessions sorted by recent activity", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-bites-tau-loader-"));
  await writeStatus(
    root,
    "older",
    status({ sessionId: "older", heartbeatAt: 10_000, lastEventAt: 12_000 }),
  );
  await writeStatus(
    root,
    "newer",
    status({ sessionId: "newer", heartbeatAt: 20_000, lastEventAt: 15_000 }),
  );

  const result = await loadTauDashboardSessions({
    agentsDir: root,
    now: () => 21_000,
    isPidLive: () => true,
  });

  expect(result.issues).toEqual([]);
  expect(result.sessions.map((session) => session.sessionId)).toEqual(["newer", "older"]);
  expect(result.sessions[0]).toMatchObject({
    sessionId: "newer",
    state: "idle",
    sourceStatus: "idle",
    activityAt: 20_000,
    isLive: true,
    isStale: false,
  });
});

test("reports invalid JSON, unsupported schemas, missing required fields, and missing files", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-bites-tau-loader-"));
  await mkdir(join(root, "sessions", "missing-file"), { recursive: true });
  await mkdir(join(root, "sessions", "bad-json"), { recursive: true });
  await writeFile(join(root, "sessions", "bad-json", "status.json"), "{ nope", "utf-8");
  await writeStatus(root, "schema", { ...status(), schemaVersion: 2 });
  await writeStatus(root, "missing-field", { ...status(), sessionId: undefined });

  const result = await loadTauDashboardSessions({ agentsDir: root });

  expect(result.sessions).toEqual([]);
  expect(result.issues.map((issue) => issue.kind).sort()).toEqual([
    "invalid-json",
    "invalid-record",
    "missing-status",
    "unsupported-schema",
  ]);
});

test("derives stopped and stale dashboard states from status, heartbeat, and pid", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-bites-tau-loader-"));
  await writeStatus(root, "stopped", status({ sessionId: "stopped", status: "stopped", pid: 222 }));
  await writeStatus(
    root,
    "dead-pid",
    status({ sessionId: "dead-pid", status: "working", pid: 333 }),
  );
  await writeStatus(
    root,
    "old-heartbeat",
    status({
      sessionId: "old-heartbeat",
      status: "idle",
      pid: 444,
      heartbeatAt: 1_000,
      lastEventAt: 1_000,
    }),
  );

  const result = await loadTauDashboardSessions({
    agentsDir: root,
    now: () => 60_000,
    staleAfterMs: 30_000,
    isPidLive: (pid) => pid !== 333,
  });

  expect(
    Object.fromEntries(result.sessions.map((session) => [session.sessionId, session.state])),
  ).toEqual({
    "dead-pid": "stale",
    stopped: "stopped",
    "old-heartbeat": "stale",
  });
  expect(result.sessions.find((session) => session.sessionId === "stopped")?.isLive).toBe(false);
});

test("missing Tau sessions directory does not crash", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-bites-tau-loader-"));

  const result = await loadTauDashboardSessions({ agentsDir: join(root, "does-not-exist") });

  expect(result.sessions).toEqual([]);
  expect(result.issues).toHaveLength(1);
  expect(result.issues[0]?.kind).toBe("read-error");
});
