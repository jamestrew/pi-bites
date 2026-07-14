import { execFileSync, spawn } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { createServer, createConnection, type Server } from "node:net";
import { fileURLToPath } from "node:url";
import { basename, dirname, join } from "node:path";
import { Type, type Static } from "typebox";
import * as Value from "typebox/value";

export type TrackerState = "idle" | "working" | "needs-input" | "needs-permission";

export const TRACKER_STATE_PRIORITY: Record<TrackerState, number> = {
  "needs-permission": 0,
  "needs-input": 1,
  working: 2,
  idle: 3,
};

export function compareTrackerStates(a: TrackerState, b: TrackerState): number {
  return TRACKER_STATE_PRIORITY[a] - TRACKER_STATE_PRIORITY[b];
}

const PaneRecordSchema = Type.Object({
  paneId: Type.String(),
  cwd: Type.String(),
  runtimeId: Type.String(),
  seq: Type.Number(),
  state: Type.Union([
    Type.Literal("idle"),
    Type.Literal("working"),
    Type.Literal("needs-input"),
    Type.Literal("needs-permission"),
  ]),
  heartbeatAt: Type.Number(),
  sessionId: Type.Optional(Type.String()),
});

export const TrackerRequestSchema = Type.Union([
  Type.Object({ type: Type.Literal("report"), record: PaneRecordSchema }),
  Type.Object({ type: Type.Literal("heartbeat"), record: PaneRecordSchema }),
  Type.Object({
    type: Type.Literal("release"),
    paneId: Type.String(),
    runtimeId: Type.String(),
  }),
  Type.Object({ type: Type.Literal("snapshot") }),
  Type.Object({ type: Type.Literal("focus_pane"), paneId: Type.String() }),
  Type.Object({ type: Type.Literal("focus_next"), currentPaneId: Type.Optional(Type.String()) }),
  Type.Object({ type: Type.Literal("shutdown") }),
]);

export const TrackerResponseSchema = Type.Object({
  ok: Type.Boolean(),
  records: Type.Optional(Type.Array(PaneRecordSchema)),
  error: Type.Optional(Type.String()),
});

export type PaneRecord = Static<typeof PaneRecordSchema>;
export type TrackerRequest = Static<typeof TrackerRequestSchema>;
export type TrackerResponse = Static<typeof TrackerResponseSchema>;

export function parseTrackerRequest(value: unknown): TrackerRequest | undefined {
  return Value.Check(TrackerRequestSchema, value) ? value : undefined;
}

export function parseTrackerResponse(value: unknown): TrackerResponse | undefined {
  return Value.Check(TrackerResponseSchema, value) ? value : undefined;
}

export type TmuxRunner = (args: string[]) => void | Promise<void>;

export interface SessionTrackerOptions {
  now: () => number;
  staleTimeoutMs: number;
  tmuxPaneExists: (paneId: string) => boolean | Promise<boolean>;
  tmuxRunner: TmuxRunner;
}

export interface SessionTrackerDaemonOptions {
  pruneIntervalMs: number;
  setInterval: typeof setInterval;
  clearInterval: typeof clearInterval;
}

export const TRACKER_HEARTBEAT_INTERVAL_MS = 10_000;
export const TRACKER_STALE_TIMEOUT_MS = 30_000;
export const TRACKER_PRUNE_INTERVAL_MS = 10_000;
const DAEMON_START_LOCK_STALE_MS = 10_000;
const DAEMON_START_LOCK_POLL_INTERVAL_MS = 25;
const TRACKER_LOG_MAX_BYTES = 512_000;

function tmuxPaneExists(paneId: string): boolean {
  try {
    execFileSync("tmux", ["display-message", "-p", "-t", paneId, "#{pane_id}"], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

const tmuxRunner: TmuxRunner = (args) => {
  execFileSync("tmux", args, { stdio: "ignore" });
};

export const defaultSessionTrackerOptions: SessionTrackerOptions = {
  now: Date.now,
  staleTimeoutMs: TRACKER_STALE_TIMEOUT_MS,
  tmuxPaneExists,
  tmuxRunner,
};

export const defaultSessionTrackerDaemonOptions: SessionTrackerDaemonOptions = {
  pruneIntervalMs: TRACKER_PRUNE_INTERVAL_MS,
  setInterval,
  clearInterval,
};

export function codeOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function codedError(message: string, code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

function formatLogError(error: unknown): string {
  const code = codeOf(error);
  const text = error instanceof Error ? (error.stack ?? error.message) : String(error);
  return `${code ? `${code} ` : ""}${text}`.replaceAll("\n", " | ");
}

export function getTrackerLogPath(socketPath = getTrackerSocketPath()): string {
  return join(dirname(socketPath), "session-tracker.log");
}

export function writeSessionTrackerLog(socketPath: string, message: string, error?: unknown): void {
  try {
    mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
    const logPath = getTrackerLogPath(socketPath);
    if (existsSync(logPath) && statSync(logPath).size > TRACKER_LOG_MAX_BYTES)
      rmSync(logPath, { force: true });
    appendFileSync(
      logPath,
      `${new Date().toISOString()} pid=${process.pid} ${message}${error ? ` error=${formatLogError(error)}` : ""}\n`,
    );
  } catch {}
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function acquireDaemonStartLock(socketPath: string): Promise<() => void> {
  const lockPath = `${socketPath}.lock`;
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      mkdirSync(lockPath);
      return () => rmSync(lockPath, { recursive: true, force: true });
    } catch (error) {
      if (codeOf(error) !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > DAEMON_START_LOCK_STALE_MS)
          rmSync(lockPath, { recursive: true, force: true });
      } catch (staleError) {
        if (codeOf(staleError) !== "ENOENT") throw staleError;
      }
      await sleep(DAEMON_START_LOCK_POLL_INTERVAL_MS);
    }
  }
  throw codedError(`Timed out waiting for ${lockPath}`, "EBUSY");
}

function socketAcceptsConnections(socketPath: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", (error) => {
      const code = codeOf(error);
      if (code === "ENOENT" || code === "ECONNREFUSED") resolve(false);
      else reject(error);
    });
  });
}

export function getTrackerSocketPath(): string {
  // Must be host-local: unix sockets bound on an NFS-mounted home only
  // rendezvous on the binding host, so shared homes cause daemon churn.
  return join(
    "/tmp",
    `pi-session-tracker-${process.getuid?.() ?? "default"}`,
    "session-tracker.sock",
  );
}

export class SessionTracker {
  private records = new Map<string, PaneRecord>();
  private now: () => number;
  private staleTimeoutMs: number;
  private tmuxPaneExists: (paneId: string) => boolean | Promise<boolean>;
  private tmuxRunner: TmuxRunner;
  private focusedPaneId: string | undefined;

  constructor(options: SessionTrackerOptions) {
    this.now = options.now;
    this.staleTimeoutMs = options.staleTimeoutMs;
    this.tmuxPaneExists = options.tmuxPaneExists;
    this.tmuxRunner = options.tmuxRunner;
  }

  async handle(request: TrackerRequest): Promise<TrackerResponse> {
    await this.prune();
    if (request.type === "snapshot") return { ok: true, records: this.snapshot() };
    if (request.type === "focus_pane") return this.focusPane(request.paneId);
    if (request.type === "focus_next") return this.focusNextPane(request.currentPaneId);
    if (request.type === "shutdown") return { ok: true };
    if (request.type === "release") {
      const current = this.records.get(request.paneId);
      if (current?.runtimeId === request.runtimeId) this.records.delete(request.paneId);
      return { ok: true };
    }

    const current = this.records.get(request.record.paneId);
    if (
      !current ||
      current.runtimeId !== request.record.runtimeId ||
      request.record.seq >= current.seq
    )
      this.records.set(request.record.paneId, { ...request.record, heartbeatAt: this.now() });
    return { ok: true };
  }

  async focusNextPane(currentPaneId?: string): Promise<TrackerResponse> {
    const records = [...this.records.values()].sort(
      (a, b) =>
        compareTrackerStates(a.state, b.state) ||
        basename(a.cwd).localeCompare(basename(b.cwd)) ||
        a.paneId.localeCompare(b.paneId),
    );
    if (records.length === 0) return { ok: false, error: "not-found" };
    const currentIndex = records.findIndex(
      (record) => record.paneId === (this.focusedPaneId ?? currentPaneId),
    );
    for (let offset = 1; offset <= records.length; offset++) {
      const response = await this.focusPane(
        records[(currentIndex + offset) % records.length].paneId,
      );
      if (response.ok || response.error !== "not-found") return response;
    }
    return { ok: false, error: "not-found" };
  }

  async focusPane(paneId: string): Promise<TrackerResponse> {
    if (!this.records.has(paneId) || !(await this.tmuxPaneExists(paneId))) {
      this.records.delete(paneId);
      return { ok: false, error: "not-found" };
    }
    try {
      await this.tmuxRunner(["switch-client", "-t", paneId]);
      this.focusedPaneId = paneId;
      return { ok: true };
    } catch (error) {
      if (!(await this.tmuxPaneExists(paneId))) {
        this.records.delete(paneId);
        return { ok: false, error: "not-found" };
      }
      return { ok: false, error: String(error) };
    }
  }

  snapshot(): PaneRecord[] {
    return [...this.records.values()].sort((a, b) => a.paneId.localeCompare(b.paneId));
  }

  async prune(): Promise<void> {
    const now = this.now();
    for (const [paneId, record] of this.records) {
      if (now - record.heartbeatAt > this.staleTimeoutMs) this.records.delete(paneId);
    }
  }
}

export async function requestTracker(
  socketPath: string,
  request: TrackerRequest,
): Promise<TrackerResponse> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let data = "";
    socket.setEncoding("utf8");
    // Frame by newline, not by connection close: half-closing after the
    // request (socket.end) tears down the whole connection on some runtimes
    // (Bun), so the response would be lost.
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk) => {
      data += chunk;
      if (!data.includes("\n")) return;
      socket.destroy();
      try {
        const response = parseTrackerResponse(JSON.parse(data.trim()));
        if (!response) throw new Error("Invalid session tracker response");
        resolve(response);
      } catch (error) {
        reject(error);
      }
    });
    socket.on("error", reject);
    socket.on("end", () =>
      reject(codedError("Session tracker closed the connection without a response", "ECONNRESET")),
    );
  });
}

export async function startSessionTrackerDaemon(
  socketPath: string,
  tracker: SessionTracker,
  options: SessionTrackerDaemonOptions,
): Promise<Server> {
  mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
  writeSessionTrackerLog(socketPath, "daemon start");
  const releaseLock = await acquireDaemonStartLock(socketPath);
  try {
    if (await socketAcceptsConnections(socketPath))
      throw codedError(`Session tracker already running at ${socketPath}`, "EADDRINUSE");
    if (existsSync(socketPath)) unlinkSync(socketPath);
  } catch (error) {
    releaseLock();
    throw error;
  }

  let closing = false;
  let server: Server;
  const closeServer = () => {
    if (closing) return;
    closing = true;
    server.close();
  };
  const closeIfIdle = () => {
    if (tracker.snapshot().length === 0) closeServer();
  };

  // allowHalfOpen keeps our write side usable if a client half-closes after
  // sending its request, so the response isn't raced against the auto-close.
  server = createServer({ allowHalfOpen: true }, (socket) => {
    let data = "";
    let handled = false;
    const writeResponse = (response: TrackerResponse) => {
      if (socket.writable) socket.end(`${JSON.stringify(response)}\n`);
    };
    const handleLine = () => {
      if (handled || !data.includes("\n")) return;
      handled = true;
      const request = parseTrackerRequest(JSON.parse(data.trim()));
      if (!request) {
        writeResponse({ ok: false, error: "Invalid session tracker request" });
        return;
      }
      if (request.type === "shutdown") {
        writeResponse({ ok: true });
        closeServer();
        return;
      }
      void tracker
        .handle(request)
        .then((response) => {
          writeResponse(response);
          if (request.type === "release") closeIfIdle();
        })
        .catch((error) => writeResponse({ ok: false, error: String(error) }));
    };
    socket.setEncoding("utf8");
    socket.on("error", (error) => {
      const code = codeOf(error);
      if (code === "EPIPE" || code === "ECONNRESET")
        writeSessionTrackerLog(socketPath, `client disconnected mid-request (${code})`);
      else writeSessionTrackerLog(socketPath, "client socket error", error);
    });
    socket.on("data", (chunk) => {
      data += chunk;
      handleLine();
    });
    socket.on("end", () => {
      // With allowHalfOpen we must close our side once the client is done;
      // if a request was handled, writeResponse's socket.end covers it.
      if (!handled) socket.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      writeSessionTrackerLog(socketPath, "daemon listen error", error);
      releaseLock();
      reject(error);
    };
    server.once("error", onError);
    server.listen(socketPath, () => {
      server.off("error", onError);
      releaseLock();
      writeSessionTrackerLog(socketPath, `daemon listening socket=${socketPath}`);
      resolve();
    });
  });

  const setTimer = options.setInterval;
  const clearTimer = options.clearInterval;
  const pruneTimer = setTimer(
    () => void tracker.prune().then(closeIfIdle),
    options.pruneIntervalMs,
  );
  pruneTimer.unref();
  server.on("close", () => {
    clearTimer(pruneTimer);
    writeSessionTrackerLog(socketPath, "daemon closed");
  });
  return server;
}

function isDebugExecArgv(arg: string): boolean {
  return arg === "--inspect" || arg.startsWith("--inspect=") || arg.startsWith("--inspect-");
}

export function getSessionTrackerDaemonCommand(
  runtime: Pick<NodeJS.Process, "execPath" | "execArgv"> = process,
): { command: string; args: string[] } {
  const servePath = fileURLToPath(new URL("./serve.ts", import.meta.url));
  const runtimeName = basename(runtime.execPath);
  if (runtimeName.startsWith("bun")) return { command: runtime.execPath, args: [servePath] };

  const args = [...runtime.execArgv.filter((arg) => !isDebugExecArgv(arg)), servePath];
  if (runtimeName.startsWith("node")) return { command: runtime.execPath, args };
  return { command: "node", args };
}

export function spawnSessionTrackerDaemon(): void {
  const socketPath = getTrackerSocketPath();
  const { command, args } = getSessionTrackerDaemonCommand();
  writeSessionTrackerLog(
    socketPath,
    `spawn daemon command=${command} args=${JSON.stringify(args)}`,
  );

  let logFd: number | undefined;
  try {
    logFd = openSync(getTrackerLogPath(socketPath), "a");
  } catch {}
  try {
    const child = spawn(command, args, {
      detached: true,
      stdio: ["ignore", logFd ?? "ignore", logFd ?? "ignore"],
    });
    writeSessionTrackerLog(socketPath, `spawned daemon childPid=${child.pid ?? "unknown"}`);
    child.on("error", (error) => writeSessionTrackerLog(socketPath, "spawn daemon error", error));
    child.unref();
  } finally {
    try {
      if (logFd !== undefined) closeSync(logFd);
    } catch {}
  }
}
