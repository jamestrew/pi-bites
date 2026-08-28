import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";

import {
  defaultSessionTrackerDaemonOptions,
  defaultSessionTrackerOptions,
  formatTmuxStatus,
  getSessionTrackerDaemonCommand,
  getTrackerPidPath,
  getTrackerLogPath,
  getTrackerSocketPath,
  getTrackerStatusPath,
  parseTrackerRequest,
  parseTrackerResponse,
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

function documentedTmuxStatusCommand(): string {
  const readme = readFileSync(join(process.cwd(), "README.md"), "utf8");
  const command = readme.match(/^set -ag status-right ' #\((.*)\)'$/m)?.[1];
  if (!command) throw new Error("README tmux status command not found");
  return command;
}

test("formats the tmux status from every tracked pane", () => {
  expect(
    formatTmuxStatus([
      record({ paneId: "%1", state: "idle" }),
      record({ paneId: "%2", state: "needs-permission" }),
      record({ paneId: "%3", state: "needs-input" }),
      record({ paneId: "%4", state: "working" }),
      record({ paneId: "%5", state: "working" }),
    ]),
  ).toBe("π 5 · !1 · ?1 · ▶2");
});

test("tmux status omits zero counters, but includes idle panes in its total", () => {
  expect(formatTmuxStatus([record({ paneId: "%1" }), record({ paneId: "%2" })])).toBe("π 2");
  expect(formatTmuxStatus([])).toBeUndefined();
});

test("parses valid tracker messages and rejects malformed ones", () => {
  const request = { type: "report", record: record(), futureField: true };
  expect(parseTrackerRequest(request)).toBe(request);
  expect(parseTrackerRequest({ type: "report", record: { state: "idle" } })).toBeUndefined();
  const response = { ok: true, records: [record()], futureField: true };
  expect(parseTrackerResponse(response)).toBe(response);
  expect(parseTrackerResponse({ ok: true, records: [{ state: "unknown" }] })).toBeUndefined();
});

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

test("daemon projects tracker changes and removes the projection on shutdown", async () => {
  const dir = tempDir();
  const socketPath = join(dir, "tracker.sock");
  const statusPath = getTrackerStatusPath(socketPath);
  const pidPath = getTrackerPidPath(socketPath);
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
    expect(readFileSync(pidPath, "utf8")).toBe(`${process.pid}\n`);
    expect(existsSync(statusPath)).toBe(false);
    await requestTracker(socketPath, { type: "report", record: record() });
    expect(readFileSync(statusPath, "utf8")).toBe("π 1\n");
    await requestTracker(socketPath, {
      type: "report",
      record: record({ seq: 2, state: "needs-permission" }),
    });
    expect(readFileSync(statusPath, "utf8")).toBe("π 1 · !1\n");

    await closeServer(server);
    expect(existsSync(statusPath)).toBe(false);
    expect(existsSync(pidPath)).toBe(false);
  } finally {
    await closeServer(server);
  }
});

test("tmux projection command prints only for a live daemon", () => {
  const dir = tempDir();
  const pidPath = join(dir, "session-tracker.pid");
  writeFileSync(join(dir, "session-tracker.status"), "π 3 · ▶2\n");
  const documentedCommand = documentedTmuxStatusCommand();
  const command = documentedCommand.replace("dir=/tmp/pi-session-tracker-$(id -u)", 'dir="$1"');
  expect(command).not.toBe(documentedCommand);
  const render = () => spawnSync("sh", ["-c", command, "sh", dir], { encoding: "utf8" }).stdout;

  writeFileSync(pidPath, `${process.pid}\n`);
  expect(render()).toBe("π 3 · ▶2\n");
  writeFileSync(pidPath, "2147483647\n");
  expect(render()).toBe("");
});

test("README documents the opt-in liveness-checked tmux segment", () => {
  const readme = readFileSync(join(process.cwd(), "README.md"), "utf8");
  const section = readme.split("## Tmux status segment")[1] ?? "";

  expect(section).toContain("session-tracker.pid");
  expect(section).toContain("session-tracker.status");
  expect(section).toContain('kill -0 "$pid"');
  expect(section).toContain("set -g status-interval 5");
  expect(section).toContain("does not start");
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

test("daemon shutdown cannot be undone by a late tracker update", async () => {
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
    const focusRequest = requestTracker(socketPath, { type: "focus_pane", paneId: "%1" });
    await paneCheck;
    const closed = new Promise((resolve) => server.once("close", resolve));
    await requestTracker(socketPath, { type: "shutdown" });
    expect(existsSync(getTrackerStatusPath(socketPath))).toBe(false);
    expect(existsSync(getTrackerPidPath(socketPath))).toBe(false);

    finishPaneCheck?.(false);
    await expect(focusRequest).resolves.toEqual({ ok: false, error: "not-found" });
    await closed;
    expect(existsSync(getTrackerStatusPath(socketPath))).toBe(false);
    expect(existsSync(getTrackerPidPath(socketPath))).toBe(false);
  } finally {
    finishPaneCheck?.(false);
    await closeServer(server);
  }
});

test("closing daemon does not remove a replacement daemon projection", async () => {
  const dir = tempDir();
  const socketPath = join(dir, "tracker.sock");
  const statusPath = getTrackerStatusPath(socketPath);
  const pidPath = getTrackerPidPath(socketPath);
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
    const focusRequest = requestTracker(socketPath, { type: "focus_pane", paneId: "%1" });
    await paneCheck;
    const closed = new Promise((resolve) => server.once("close", resolve));
    server.close();
    writeFileSync(pidPath, "12345\n");
    writeFileSync(statusPath, "π 9 · ▶9\n");
    finishPaneCheck?.(false);
    await focusRequest;
    await closed;

    expect(readFileSync(pidPath, "utf8")).toBe("12345\n");
    expect(readFileSync(statusPath, "utf8")).toBe("π 9 · ▶9\n");
  } finally {
    finishPaneCheck?.(false);
    await closeServer(server);
  }
});

test("daemon cleanup reaps an abandoned projection lock", async () => {
  const dir = tempDir();
  const socketPath = join(dir, "tracker.sock");
  const server = await startSessionTrackerDaemon(
    socketPath,
    new SessionTracker(defaultSessionTrackerOptions),
    {
      ...defaultSessionTrackerDaemonOptions,
      setInterval: (() => ({ unref() {} }) as ReturnType<typeof setInterval>) as typeof setInterval,
      clearInterval: (() => {}) as typeof clearInterval,
    },
  );

  await requestTracker(socketPath, { type: "report", record: record() });
  expect(existsSync(getTrackerStatusPath(socketPath))).toBe(true);
  mkdirSync(`${socketPath}.projection.lock`);
  try {
    await closeServer(server);
    await vi.waitFor(
      () => {
        expect(existsSync(getTrackerPidPath(socketPath))).toBe(false);
        expect(existsSync(getTrackerStatusPath(socketPath))).toBe(false);
      },
      { timeout: 2_000, interval: 25 },
    );
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
