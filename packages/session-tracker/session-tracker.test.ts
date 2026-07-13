import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import {
  defaultSessionTrackerDaemonOptions,
  defaultSessionTrackerOptions,
  getSessionTrackerDaemonCommand,
  getTrackerLogPath,
  getTrackerSocketPath,
  requestTracker,
  SessionTracker,
  startSessionTrackerDaemon,
  writeSessionTrackerLog,
  type PaneRecord,
} from "./index.js";

const tempDirs: string[] = [];

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "pi-bites-tracker-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function closeServer(server: ReturnType<typeof createServer>) {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

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
  const tracker = new SessionTracker({
    ...defaultSessionTrackerOptions,
    tmuxPaneExists: () => true,
  });
  await tracker.handle({ type: "report", record: record() });
  await tracker.handle({ type: "release", paneId: "%1", runtimeId: "other" });
  expect(tracker.snapshot()).toHaveLength(1);

  await tracker.handle({ type: "release", paneId: "%1", runtimeId: "runtime-a" });
  expect(tracker.snapshot()).toEqual([]);
});

test("stores current state by pane and ignores stale same-runtime sequences", async () => {
  const tracker = new SessionTracker({
    ...defaultSessionTrackerOptions,
    now: () => 1_000,
    tmuxPaneExists: () => true,
  });
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
  const tracker = new SessionTracker({
    ...defaultSessionTrackerOptions,
    now: () => now,
    tmuxPaneExists: () => true,
  });
  await tracker.handle({ type: "report", record: record({ seq: 1 }) });
  now = 9_000;
  await tracker.handle({ type: "heartbeat", record: record({ seq: 2, state: "working" }) });

  expect(tracker.snapshot()).toEqual([record({ seq: 2, state: "working", heartbeatAt: 9_000 })]);
});

test("prunes stale pane records", async () => {
  let now = 1_000;
  const tracker = new SessionTracker({
    ...defaultSessionTrackerOptions,
    now: () => now,
    staleTimeoutMs: 10,
    tmuxPaneExists: () => true,
  });
  await tracker.handle({ type: "report", record: record() });
  now = 1_011;

  await tracker.prune();
  expect(tracker.snapshot()).toEqual([]);
});

test("keeps tmux checks out of the prune hot path", async () => {
  let paneChecks = 0;
  const tracker = new SessionTracker({
    ...defaultSessionTrackerOptions,
    now: () => 1_000,
    tmuxPaneExists: () => {
      paneChecks++;
      return false;
    },
  });
  await tracker.handle({ type: "report", record: record({ paneId: "%1" }) });

  await tracker.prune();
  expect(paneChecks).toBe(0);
  expect(tracker.snapshot()).toEqual([record({ paneId: "%1" })]);

  await expect(tracker.focusPane("%1")).resolves.toEqual({ ok: false, error: "not-found" });
  expect(paneChecks).toBe(1);
  expect(tracker.snapshot()).toEqual([]);
});

test("daemon command uses the current Node runtime instead of requiring bun", () => {
  const command = getSessionTrackerDaemonCommand({
    execPath: "/usr/bin/node",
    execArgv: ["--experimental-strip-types"],
  });

  expect(command.command).toBe("/usr/bin/node");
  expect(command.args.at(-1)).toMatch(/serve\.ts$/);
  expect(command.args).toContain("--experimental-strip-types");
});

test("daemon command omits Node debug flags that would collide in the child", () => {
  const command = getSessionTrackerDaemonCommand({
    execPath: "/usr/bin/node",
    execArgv: ["--experimental-strip-types", "--inspect=127.0.0.1:9229", "--inspect-brk"],
  });

  expect(command.args).toContain("--experimental-strip-types");
  expect(command.args).not.toContain("--inspect=127.0.0.1:9229");
  expect(command.args).not.toContain("--inspect-brk");
});

test("daemon command keeps the bun source-development flow", () => {
  const command = getSessionTrackerDaemonCommand({ execPath: "/usr/bin/bun", execArgv: [] });

  expect(command.command).toBe("/usr/bin/bun");
  expect(command.args).toHaveLength(1);
  expect(command.args[0]).toMatch(/serve\.ts$/);
});

test("daemon command falls back to node when pi is the executable", () => {
  const command = getSessionTrackerDaemonCommand({
    execPath: "/opt/pi/bin/pi",
    execArgv: ["--experimental-strip-types", "--inspect=127.0.0.1:9229"],
  });

  expect(command.command).toBe("node");
  expect(command.args.at(-1)).toMatch(/serve\.ts$/);
  expect(command.args).toContain("--experimental-strip-types");
  expect(command.args).not.toContain("--inspect=127.0.0.1:9229");
});

test("tracker socket lives in a host-local per-user directory", () => {
  expect(getTrackerSocketPath()).toBe(
    join("/tmp", `pi-session-tracker-${process.getuid?.() ?? "default"}`, "session-tracker.sock"),
  );
});

test("writes daemon debug logs beside the socket", () => {
  const dir = tempDir();
  const socketPath = join(dir, "tracker.sock");

  try {
    writeSessionTrackerLog(socketPath, "spawned daemon childPid=123");

    const log = readFileSync(getTrackerLogPath(socketPath), "utf8");
    expect(log).toContain(`pid=${process.pid}`);
    expect(log).toContain("spawned daemon childPid=123");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("daemon ingests reports and returns snapshots over newline JSON", async () => {
  const dir = tempDir();
  const socketPath = join(dir, "tracker.sock");
  const server = await startSessionTrackerDaemon(
    socketPath,
    new SessionTracker({
      ...defaultSessionTrackerOptions,
      now: () => 1_000,
      tmuxPaneExists: () => true,
    }),
    {
      ...defaultSessionTrackerDaemonOptions,
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
    await closeServer(server);
  }
});

test("daemon shuts down over newline JSON", async () => {
  const dir = tempDir();
  const socketPath = join(dir, "tracker.sock");
  const server = await startSessionTrackerDaemon(
    socketPath,
    new SessionTracker({ ...defaultSessionTrackerOptions, tmuxPaneExists: () => true }),
    {
      ...defaultSessionTrackerDaemonOptions,
      setInterval: (() => ({ unref() {} }) as ReturnType<typeof setInterval>) as typeof setInterval,
      clearInterval: (() => {}) as typeof clearInterval,
    },
  );

  try {
    const closed = new Promise((resolve) => server.once("close", resolve));
    await expect(requestTracker(socketPath, { type: "shutdown" })).resolves.toEqual({ ok: true });
    await closed;
  } finally {
    await closeServer(server);
  }
});

test("daemon exits when the last pane releases", async () => {
  const dir = tempDir();
  const socketPath = join(dir, "tracker.sock");
  const server = await startSessionTrackerDaemon(
    socketPath,
    new SessionTracker({ ...defaultSessionTrackerOptions, tmuxPaneExists: () => true }),
    {
      ...defaultSessionTrackerDaemonOptions,
      setInterval: (() => ({ unref() {} }) as ReturnType<typeof setInterval>) as typeof setInterval,
      clearInterval: (() => {}) as typeof clearInterval,
    },
  );

  try {
    await requestTracker(socketPath, { type: "report", record: record() });
    const closed = new Promise((resolve) => server.once("close", resolve));
    await expect(
      requestTracker(socketPath, { type: "release", paneId: "%1", runtimeId: "runtime-a" }),
    ).resolves.toEqual({ ok: true });
    await closed;
  } finally {
    await closeServer(server);
  }
});

test("daemon keeps serving after a client disconnects before the response", async () => {
  const dir = tempDir();
  const socketPath = join(dir, "tracker.sock");
  let paneCheckStarted: (() => void) | undefined;
  let finishPaneCheck: ((exists: boolean) => void) | undefined;
  const tracker = new SessionTracker({
    ...defaultSessionTrackerOptions,
    now: () => 1_000,
    tmuxPaneExists: () => {
      paneCheckStarted?.();
      return new Promise<boolean>((resolve) => {
        finishPaneCheck = resolve;
      });
    },
  });
  await tracker.handle({ type: "report", record: record() });
  const server = await startSessionTrackerDaemon(socketPath, tracker, {
    ...defaultSessionTrackerDaemonOptions,
    setInterval: (() => ({ unref() {} }) as ReturnType<typeof setInterval>) as typeof setInterval,
    clearInterval: (() => {}) as typeof clearInterval,
  });

  try {
    const paneCheck = new Promise<void>((resolve) => {
      paneCheckStarted = resolve;
    });
    const client = createConnection(socketPath);
    client.on("error", () => {});
    await new Promise<void>((resolve) => client.once("connect", resolve));
    client.write(`${JSON.stringify({ type: "focus_pane", paneId: "%1" })}\n`);
    await paneCheck;
    client.destroy();
    finishPaneCheck?.(false);

    await expect(requestTracker(socketPath, { type: "snapshot" })).resolves.toEqual({
      ok: true,
      records: [],
    });
    expect(readFileSync(getTrackerLogPath(socketPath), "utf8")).not.toContain(
      "client socket error",
    );
  } finally {
    await closeServer(server);
  }
});

test("daemon start leaves a live socket alone", async () => {
  const dir = tempDir();
  const socketPath = join(dir, "tracker.sock");
  const existing = createServer((socket) => {
    socket.on("data", () => socket.end(`${JSON.stringify({ ok: true })}\n`));
  });
  await new Promise<void>((resolve) => existing.listen(socketPath, resolve));

  try {
    await expect(
      startSessionTrackerDaemon(
        socketPath,
        new SessionTracker({ ...defaultSessionTrackerOptions, tmuxPaneExists: () => true }),
        {
          ...defaultSessionTrackerDaemonOptions,
          setInterval: (() =>
            ({ unref() {} }) as ReturnType<typeof setInterval>) as typeof setInterval,
          clearInterval: (() => {}) as typeof clearInterval,
        },
      ),
    ).rejects.toMatchObject({ code: "EADDRINUSE" });
    await expect(requestTracker(socketPath, { type: "snapshot" })).resolves.toEqual({ ok: true });
  } finally {
    await closeServer(existing);
  }
});

test("daemon exits when periodic prune removes the last pane", async () => {
  const dir = tempDir();
  const socketPath = join(dir, "tracker.sock");
  let prune: (() => void) | undefined;
  let now = 1_000;
  const tracker = new SessionTracker({
    ...defaultSessionTrackerOptions,
    now: () => now,
    staleTimeoutMs: 10,
    tmuxPaneExists: () => true,
  });
  const server = await startSessionTrackerDaemon(socketPath, tracker, {
    ...defaultSessionTrackerDaemonOptions,
    setInterval: ((callback: () => void) => {
      prune = callback;
      return { unref() {} } as ReturnType<typeof setInterval>;
    }) as typeof setInterval,
    clearInterval: (() => {}) as typeof clearInterval,
  });

  try {
    await tracker.handle({ type: "report", record: record() });
    const closed = new Promise((resolve) => server.once("close", resolve));
    now = 1_011;
    prune?.();

    await closed;
    expect(tracker.snapshot()).toEqual([]);
  } finally {
    await closeServer(server);
  }
});

test("focuses a tracked existing pane by tmux pane id", async () => {
  const calls: string[][] = [];
  const tracker = new SessionTracker({
    ...defaultSessionTrackerOptions,
    tmuxPaneExists: () => true,
    tmuxRunner: (args) => {
      calls.push(args);
    },
  });
  await tracker.handle({ type: "report", record: record({ paneId: "%7" }) });

  await expect(tracker.handle({ type: "focus_pane", paneId: "%7" })).resolves.toEqual({ ok: true });
  expect(calls).toEqual([["switch-client", "-t", "%7"]]);
});

test("focus next cycles blocked, needs-input, working, then idle panes", async () => {
  const calls: string[][] = [];
  const tracker = new SessionTracker({
    ...defaultSessionTrackerOptions,
    tmuxPaneExists: () => true,
    tmuxRunner: (args) => {
      calls.push(args);
    },
  });
  await tracker.handle({
    type: "report",
    record: record({ paneId: "%3", cwd: "/repo/working", state: "working" }),
  });
  await tracker.handle({
    type: "report",
    record: record({ paneId: "%1", cwd: "/repo/blocked", state: "needs-permission" }),
  });
  await tracker.handle({
    type: "report",
    record: record({ paneId: "%2", cwd: "/repo/idle", state: "idle" }),
  });
  await tracker.handle({
    type: "report",
    record: record({ paneId: "%4", cwd: "/repo/input", state: "needs-input" }),
  });

  await expect(tracker.handle({ type: "focus_next", currentPaneId: "%1" })).resolves.toEqual({
    ok: true,
  });
  await expect(tracker.handle({ type: "focus_next", currentPaneId: "%1" })).resolves.toEqual({
    ok: true,
  });
  await expect(tracker.handle({ type: "focus_next", currentPaneId: "%1" })).resolves.toEqual({
    ok: true,
  });
  await expect(tracker.handle({ type: "focus_next", currentPaneId: "%1" })).resolves.toEqual({
    ok: true,
  });

  expect(calls).toEqual([
    ["switch-client", "-t", "%4"],
    ["switch-client", "-t", "%3"],
    ["switch-client", "-t", "%2"],
    ["switch-client", "-t", "%1"],
  ]);
});

test("focus next skips panes that vanished before selection", async () => {
  const calls: string[][] = [];
  const tracker = new SessionTracker({
    ...defaultSessionTrackerOptions,
    now: () => 1_000,
    tmuxPaneExists: (paneId) => paneId === "%2",
    tmuxRunner: (args) => {
      calls.push(args);
    },
  });
  await tracker.handle({ type: "report", record: record({ paneId: "%1" }) });
  await tracker.handle({ type: "report", record: record({ paneId: "%2" }) });

  await expect(tracker.handle({ type: "focus_next" })).resolves.toEqual({ ok: true });

  expect(calls).toEqual([["switch-client", "-t", "%2"]]);
  expect(tracker.snapshot()).toEqual([record({ paneId: "%2" })]);
});

test("focus returns not-found for unknown panes", async () => {
  const tracker = new SessionTracker({
    ...defaultSessionTrackerOptions,
    tmuxPaneExists: () => true,
  });

  await expect(tracker.handle({ type: "focus_pane", paneId: "%404" })).resolves.toEqual({
    ok: false,
    error: "not-found",
  });
});

test("focus prunes panes that vanish before selection", async () => {
  const tracker = new SessionTracker({
    ...defaultSessionTrackerOptions,
    tmuxPaneExists: () => false,
  });
  await tracker.handle({ type: "report", record: record({ paneId: "%9" }) });

  await expect(tracker.handle({ type: "focus_pane", paneId: "%9" })).resolves.toEqual({
    ok: false,
    error: "not-found",
  });
  expect(tracker.snapshot()).toEqual([]);
});

test("focus reports tmux command failures without deleting live panes", async () => {
  const tracker = new SessionTracker({
    ...defaultSessionTrackerOptions,
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
