import { execFileSync, spawn } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, createConnection, type Server } from "node:net";
import { fileURLToPath } from "node:url";
import { basename, dirname, join } from "node:path";

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

export function formatTmuxStatus(records: readonly PaneRecord[]): string | undefined {
  if (records.length === 0) return undefined;
  const counts = { "needs-permission": 0, "needs-input": 0, working: 0 };
  for (const { state } of records) {
    if (state !== "idle") counts[state]++;
  }
  return [
    `π ${records.length}`,
    counts["needs-permission"] ? `!${counts["needs-permission"]}` : undefined,
    counts["needs-input"] ? `?${counts["needs-input"]}` : undefined,
    counts.working ? `▶${counts.working}` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
}

export interface PaneRecord {
  paneId: string;
  cwd: string;
  runtimeId: string;
  seq: number;
  state: TrackerState;
  heartbeatAt: number;
  sessionId?: string;
}

export type TrackerRequest =
  | { type: "report"; record: PaneRecord }
  | { type: "heartbeat"; record: PaneRecord }
  | { type: "release"; paneId: string; runtimeId: string }
  | { type: "snapshot" }
  | { type: "focus_pane"; paneId: string }
  | { type: "focus_next"; currentPaneId?: string; targetClient?: string }
  | { type: "shutdown" };

export interface TrackerResponse {
  ok: boolean;
  records?: PaneRecord[];
  error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTrackerState(value: unknown): value is TrackerState {
  return typeof value === "string" && Object.hasOwn(TRACKER_STATE_PRIORITY, value);
}

function isPaneRecord(value: unknown): value is PaneRecord {
  return (
    isRecord(value) &&
    typeof value.paneId === "string" &&
    typeof value.cwd === "string" &&
    typeof value.runtimeId === "string" &&
    typeof value.seq === "number" &&
    isTrackerState(value.state) &&
    typeof value.heartbeatAt === "number" &&
    (!("sessionId" in value) || typeof value.sessionId === "string")
  );
}

function isTrackerRequest(value: unknown): value is TrackerRequest {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "report":
    case "heartbeat":
      return isPaneRecord(value.record);
    case "release":
      return typeof value.paneId === "string" && typeof value.runtimeId === "string";
    case "focus_pane":
      return typeof value.paneId === "string";
    case "focus_next":
      return (
        (!("currentPaneId" in value) || typeof value.currentPaneId === "string") &&
        (!("targetClient" in value) || typeof value.targetClient === "string")
      );
    case "snapshot":
    case "shutdown":
      return true;
    default:
      return false;
  }
}

export function parseTrackerRequest(value: unknown): TrackerRequest | undefined {
  return isTrackerRequest(value) ? value : undefined;
}

function isTrackerResponse(value: unknown): value is TrackerResponse {
  return (
    isRecord(value) &&
    typeof value.ok === "boolean" &&
    (!("records" in value) ||
      (Array.isArray(value.records) && value.records.every(isPaneRecord))) &&
    (!("error" in value) || typeof value.error === "string")
  );
}

export function parseTrackerResponse(value: unknown): TrackerResponse | undefined {
  return isTrackerResponse(value) ? value : undefined;
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
const TRACKER_LOCK_POLL_INTERVAL_MS = 25;
const PROJECTION_LOCK_STALE_MS = 1_000;
const PROJECTION_LOCK_MAX_ATTEMPTS = 80;
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

export function getTrackerStatusPath(socketPath = getTrackerSocketPath()): string {
  return join(dirname(socketPath), "session-tracker.status");
}

export function getTrackerPidPath(socketPath = getTrackerSocketPath()): string {
  return join(dirname(socketPath), "session-tracker.pid");
}

function writeAtomic(path: string, contents: string): void {
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, contents, { mode: 0o600 });
  renameSync(temporaryPath, path);
}

function createTrackerStatusProjection(socketPath: string) {
  const statusPath = getTrackerStatusPath(socketPath);
  const pidPath = getTrackerPidPath(socketPath);
  const pidContents = `${process.pid}\n`;
  let active = true;
  rmSync(statusPath, { force: true });
  writeAtomic(pidPath, pidContents);

  const ownsProjection = () => {
    try {
      return readFileSync(pidPath, "utf8") === pidContents;
    } catch (error) {
      if (codeOf(error) === "ENOENT") return false;
      throw error;
    }
  };

  return {
    update(records: readonly PaneRecord[]) {
      if (!active || !ownsProjection()) return;
      const status = formatTmuxStatus(records);
      if (status) writeAtomic(statusPath, `${status}\n`);
      else rmSync(statusPath, { force: true });
    },
    cleanup() {
      if (!active) return;
      active = false;
      if (!ownsProjection()) return;
      rmSync(statusPath, { force: true });
      rmSync(pidPath, { force: true });
    },
  };
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

async function acquireFileLock(
  lockPath: string,
  staleMs: number,
  maxAttempts: number,
): Promise<() => void> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      mkdirSync(lockPath);
      return () => rmSync(lockPath, { recursive: true, force: true });
    } catch (error) {
      if (codeOf(error) !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > staleMs)
          rmSync(lockPath, { recursive: true, force: true });
      } catch (staleError) {
        if (codeOf(staleError) !== "ENOENT") throw staleError;
      }
      await sleep(TRACKER_LOCK_POLL_INTERVAL_MS);
    }
  }
  throw codedError(`Timed out waiting for ${lockPath}`, "EBUSY");
}

function acquireDaemonStartLock(socketPath: string): Promise<() => void> {
  return acquireFileLock(
    `${socketPath}.lock`,
    DAEMON_START_LOCK_STALE_MS,
    Math.ceil(DAEMON_START_LOCK_STALE_MS / TRACKER_LOCK_POLL_INTERVAL_MS) + 200,
  );
}

function acquireProjectionLock(socketPath: string): Promise<() => void> {
  return acquireFileLock(
    `${socketPath}.projection.lock`,
    PROJECTION_LOCK_STALE_MS,
    PROJECTION_LOCK_MAX_ATTEMPTS,
  );
}

async function withTrackerRuntimeLock(socketPath: string, action: () => void): Promise<void> {
  const releaseLock = await acquireProjectionLock(socketPath);
  try {
    action();
  } finally {
    releaseLock();
  }
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
    if (request.type === "focus_next")
      return this.focusNextPane(request.currentPaneId, request.targetClient);
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

  async focusNextPane(currentPaneId?: string, targetClient?: string): Promise<TrackerResponse> {
    const records = [...this.records.values()].sort(
      (a, b) =>
        compareTrackerStates(a.state, b.state) ||
        basename(a.cwd).localeCompare(basename(b.cwd)) ||
        a.paneId.localeCompare(b.paneId),
    );
    if (records.length === 0) return { ok: false, error: "not-found" };
    const currentIndex = records.findIndex(
      (record) =>
        record.paneId === (targetClient ? currentPaneId : (this.focusedPaneId ?? currentPaneId)),
    );
    for (let offset = 1; offset <= records.length; offset++) {
      const record = records[(currentIndex + offset) % records.length];
      if (!record) continue;
      const response = await this.focusPane(record.paneId, targetClient);
      if (response.ok || response.error !== "not-found") return response;
    }
    return { ok: false, error: "not-found" };
  }

  async focusPane(paneId: string, targetClient?: string): Promise<TrackerResponse> {
    if (!this.records.has(paneId) || !(await this.tmuxPaneExists(paneId))) {
      this.records.delete(paneId);
      return { ok: false, error: "not-found" };
    }
    try {
      await this.tmuxRunner([
        "switch-client",
        ...(targetClient ? ["-c", targetClient] : []),
        "-t",
        paneId,
      ]);
      if (!targetClient) this.focusedPaneId = paneId;
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
  const releaseStartLock = await acquireDaemonStartLock(socketPath);
  let releaseProjectionLock: () => void;
  try {
    if (await socketAcceptsConnections(socketPath))
      throw codedError(`Session tracker already running at ${socketPath}`, "EADDRINUSE");
    if (existsSync(socketPath)) unlinkSync(socketPath);
    releaseProjectionLock = await acquireProjectionLock(socketPath);
  } catch (error) {
    releaseStartLock();
    throw error;
  }

  let closing = false;
  let server: Server;
  let cleanupProjection = async () => {};
  let updateProjection = async () => {};
  const closeServer = () => {
    if (closing) return;
    closing = true;
    void cleanupProjection();
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
        .then(async (response) => {
          await updateProjection();
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
      releaseProjectionLock();
      releaseStartLock();
      reject(error);
    };
    server.once("error", onError);
    server.listen(socketPath, () => {
      server.off("error", onError);
      writeSessionTrackerLog(socketPath, `daemon listening socket=${socketPath}`);
      resolve();
    });
  });

  let projection: ReturnType<typeof createTrackerStatusProjection>;
  try {
    projection = createTrackerStatusProjection(socketPath);
    projection.update(tracker.snapshot());
  } catch (error) {
    server.close();
    throw error;
  } finally {
    releaseProjectionLock();
    releaseStartLock();
  }
  let cleanupPromise: Promise<void> | undefined;
  cleanupProjection = () =>
    (cleanupPromise ??= withTrackerRuntimeLock(socketPath, () => projection.cleanup()).catch(
      (error) => writeSessionTrackerLog(socketPath, "status projection cleanup failed", error),
    ));
  updateProjection = async () => {
    try {
      await withTrackerRuntimeLock(socketPath, () => projection.update(tracker.snapshot()));
    } catch (error) {
      writeSessionTrackerLog(socketPath, "status projection update failed", error);
    }
  };

  const setTimer = options.setInterval;
  const clearTimer = options.clearInterval;
  const pruneTimer = setTimer(
    () =>
      void tracker.prune().then(async () => {
        await updateProjection();
        closeIfIdle();
      }),
    options.pruneIntervalMs,
  );
  pruneTimer.unref();
  server.on("close", () => {
    clearTimer(pruneTimer);
    void cleanupProjection();
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
