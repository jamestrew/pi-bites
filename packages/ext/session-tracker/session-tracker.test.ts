import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createSessionTrackerRuntime,
  createSessionTrackerServer,
  sendSessionTrackerRequest,
  SessionTrackerStore,
  type SessionTrackerRequest,
} from "./index.js";

const record = {
  paneId: "%1",
  cwd: "/tmp/project",
  runtimeId: "runtime-1",
  sequence: 1,
  state: "idle" as const,
  reportedAt: 123,
  sessionId: "session-1",
};

afterEach(() => vi.restoreAllMocks());

describe("SessionTrackerStore", () => {
  test("stores current state by tmux pane", () => {
    const store = new SessionTrackerStore();
    store.report({ ...record, sessionId: "old", state: "working" });
    store.report({ ...record, sessionId: "new", state: "idle", sequence: 2 });

    expect(store.snapshot()).toEqual([{ ...record, sessionId: "new", state: "idle", sequence: 2 }]);
  });
});

describe("session tracker daemon protocol", () => {
  test("ingests reports and returns snapshots", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-bites-session-tracker-"));
    const socketPath = join(dir, "tracker.sock");
    const server = createSessionTrackerServer();
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));

    try {
      await sendSessionTrackerRequest({ type: "report", record }, socketPath);
      await expect(sendSessionTrackerRequest({ type: "snapshot" }, socketPath)).resolves.toEqual({
        ok: true,
        panes: [record],
      });
    } finally {
      server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("session tracker runtime", () => {
  test("adds runtime id and increments sequence", async () => {
    const sent: SessionTrackerRequest[] = [];
    const runtime = createSessionTrackerRuntime({
      paneId: "%2",
      runtimeId: "runtime-2",
      now: () => 10,
      send: async (request) => {
        sent.push(request);
        return { ok: true };
      },
    });

    await runtime.start({
      cwd: "/repo",
      sessionManager: { getSessionId: () => "s1", getSessionFile: () => "/sessions/s1.jsonl" },
    });
    await runtime.setState("working");

    expect(sent).toEqual([
      {
        type: "report",
        record: {
          paneId: "%2",
          cwd: "/repo",
          runtimeId: "runtime-2",
          sessionId: "s1",
          sessionFile: "/sessions/s1.jsonl",
          state: "idle",
          sequence: 1,
          reportedAt: 10,
        },
      },
      { type: "snapshot" },
      {
        type: "report",
        record: {
          paneId: "%2",
          cwd: "/repo",
          runtimeId: "runtime-2",
          sessionId: "s1",
          sessionFile: "/sessions/s1.jsonl",
          state: "working",
          sequence: 2,
          reportedAt: 10,
        },
      },
    ]);
  });

  test("starts daemon and retries until it is ready", async () => {
    const spawnDaemon = vi.fn();
    const send = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("missing"), { code: "ENOENT" }))
      .mockRejectedValueOnce(Object.assign(new Error("missing"), { code: "ENOENT" }))
      .mockResolvedValue({ ok: true });
    const runtime = createSessionTrackerRuntime({
      paneId: "%3",
      runtimeId: "runtime-3",
      send,
      spawnDaemon,
      waitAfterSpawn: async () => {},
      retryIntervalMs: 0,
      daemonStartupTimeoutMs: 100,
    });

    await runtime.start({ cwd: "/repo" });

    expect(spawnDaemon).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(4);
  });

  test("reports permission-gated state", async () => {
    const sent: SessionTrackerRequest[] = [];
    const runtime = createSessionTrackerRuntime({
      paneId: "%4",
      runtimeId: "runtime-4",
      now: () => 20,
      send: async (request) => {
        sent.push(request);
        return { ok: true };
      },
    });

    await runtime.start({ cwd: "/repo" });
    await runtime.agentStart();
    await runtime.permissionNeeded();
    await runtime.permissionResolved();

    expect(
      sent.filter((request) => request.type === "report").map((request) => request.record.state),
    ).toEqual(["idle", "working", "needs-permission", "working"]);
  });

  test("does nothing outside tmux", async () => {
    const send = vi.fn();
    const runtime = createSessionTrackerRuntime({ paneId: undefined, send });

    await runtime.start({ cwd: "/repo" });

    expect(send).not.toHaveBeenCalled();
  });
});
