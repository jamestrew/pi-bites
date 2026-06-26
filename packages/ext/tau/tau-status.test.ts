import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import {
  buildTauStatusPayload,
  deriveTauStatusPaths,
  publishTauStatusForSession,
  writeTauStatusSidecar,
} from "./index.js";

test("buildTauStatusPayload creates the initial idle Tau status shape", () => {
  expect(
    buildTauStatusPayload({
      sessionId: "session-123",
      sessionFile: "/home/me/.pi/agent/sessions/repo/session-123.jsonl",
      cwd: "/repo",
      pid: 1234,
      ppid: 567,
      now: 1_700_000_000_000,
    }),
  ).toEqual({
    schemaVersion: 1,
    sessionId: "session-123",
    sessionFile: "/home/me/.pi/agent/sessions/repo/session-123.jsonl",
    cwd: "/repo",
    pid: 1234,
    ppid: 567,
    startedAt: 1_700_000_000_000,
    heartbeatAt: 1_700_000_000_000,
    lastEventAt: 1_700_000_000_000,
    status: "idle",
  });
});

test("deriveTauStatusPaths places status under the pi-agents session directory", () => {
  expect(deriveTauStatusPaths("session-123", "/home/me/.pi/agents")).toEqual({
    directory: "/home/me/.pi/agents/sessions/session-123",
    statusFile: "/home/me/.pi/agents/sessions/session-123/status.json",
  });
});

test("writeTauStatusSidecar creates missing directories and only writes status.json", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-bites-tau-status-"));
  const paths = deriveTauStatusPaths("session-123", root);
  const sessionJsonl = join(root, "canonical-session.jsonl");
  const payload = buildTauStatusPayload({
    sessionId: "session-123",
    sessionFile: sessionJsonl,
    cwd: "/repo",
    pid: 1234,
    now: 1_700_000_000_000,
  });

  await writeTauStatusSidecar(payload, paths);

  expect(existsSync(paths.directory)).toBe(true);
  expect(readdirSync(paths.directory)).toEqual(["status.json"]);
  expect(JSON.parse(readFileSync(paths.statusFile, "utf-8"))).toEqual(payload);
  expect(existsSync(sessionJsonl)).toBe(false);
});

test("publishTauStatusForSession reports write failures without throwing", async () => {
  const errors: unknown[] = [];

  await expect(
    publishTauStatusForSession(
      {
        cwd: "/repo",
        sessionManager: {
          getSessionId: () => "session-123",
          getSessionFile: () => "/home/me/.pi/agent/sessions/repo/session-123.jsonl",
        },
      },
      {
        pid: 1234,
        now: () => 1_700_000_000_000,
        writeSidecar: async () => {
          throw new Error("permission denied");
        },
        onError: (error) => errors.push(error),
      },
    ),
  ).resolves.toBeUndefined();

  expect(errors).toHaveLength(1);
  expect(String(errors[0])).toContain("permission denied");
});
