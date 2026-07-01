import { execFileSync, spawn } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { createServer, createConnection, type Server } from "node:net";
import { join } from "node:path";

export type TrackerState = "idle" | "working" | "needs-permission";

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
  | { type: "snapshot" };

export interface TrackerResponse {
  ok: boolean;
  records?: PaneRecord[];
  error?: string;
}

export interface SessionTrackerOptions {
  now?: () => number;
  staleTimeoutMs?: number;
  tmuxPaneExists?: (paneId: string) => boolean | Promise<boolean>;
}

export interface SessionTrackerDaemonOptions {
  pruneIntervalMs?: number;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
}

export const TRACKER_HEARTBEAT_INTERVAL_MS = 10_000;
export const TRACKER_STALE_TIMEOUT_MS = 30_000;
export const TRACKER_PRUNE_INTERVAL_MS = 10_000;

export function getTrackerSocketPath(): string {
  return join(
    process.env.PI_AGENT_DIR ?? join(process.env.HOME ?? ".", ".pi", "agent"),
    "session-tracker.sock",
  );
}

export class SessionTracker {
  private records = new Map<string, PaneRecord>();
  private now: () => number;
  private staleTimeoutMs: number;
  private tmuxPaneExists: (paneId: string) => boolean | Promise<boolean>;

  constructor(options: SessionTrackerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.staleTimeoutMs = options.staleTimeoutMs ?? TRACKER_STALE_TIMEOUT_MS;
    this.tmuxPaneExists =
      options.tmuxPaneExists ??
      ((paneId) => {
        try {
          execFileSync("tmux", ["display-message", "-p", "-t", paneId, "#{pane_id}"], {
            stdio: "ignore",
          });
          return true;
        } catch {
          return false;
        }
      });
  }

  async handle(request: TrackerRequest): Promise<TrackerResponse> {
    await this.prune();
    if (request.type === "snapshot") return { ok: true, records: this.snapshot() };
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

  snapshot(): PaneRecord[] {
    return [...this.records.values()].sort((a, b) => a.paneId.localeCompare(b.paneId));
  }

  async prune(): Promise<void> {
    const now = this.now();
    for (const [paneId, record] of this.records) {
      if (now - record.heartbeatAt > this.staleTimeoutMs || !(await this.tmuxPaneExists(paneId)))
        this.records.delete(paneId);
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
    socket.on("connect", () => socket.end(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk) => (data += chunk));
    socket.on("error", reject);
    socket.on("end", () => {
      try {
        resolve(JSON.parse(data) as TrackerResponse);
      } catch (error) {
        reject(error);
      }
    });
  });
}

export async function startSessionTrackerDaemon(
  socketPath = getTrackerSocketPath(),
  tracker = new SessionTracker(),
  options: SessionTrackerDaemonOptions = {},
): Promise<Server> {
  if (existsSync(socketPath)) unlinkSync(socketPath);
  const server = createServer((socket) => {
    let data = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => (data += chunk));
    socket.on("end", () => {
      void tracker
        .handle(JSON.parse(data.trim()) as TrackerRequest)
        .then((response) => socket.end(`${JSON.stringify(response)}\n`))
        .catch((error) => socket.end(`${JSON.stringify({ ok: false, error: String(error) })}\n`));
    });
  });
  const setTimer = options.setInterval ?? setInterval;
  const clearTimer = options.clearInterval ?? clearInterval;
  const pruneTimer = setTimer(
    () => void tracker.prune(),
    options.pruneIntervalMs ?? TRACKER_PRUNE_INTERVAL_MS,
  );
  pruneTimer.unref?.();
  server.on("close", () => clearTimer(pruneTimer));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return server;
}

export function spawnSessionTrackerDaemon(): void {
  const child = spawn(process.execPath, [new URL("./serve.ts", import.meta.url).pathname], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}
