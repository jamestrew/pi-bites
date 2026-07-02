import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { createServer, createConnection, type Server } from "node:net";
import { fileURLToPath } from "node:url";
import { basename, dirname, join } from "node:path";

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
  | { type: "snapshot" }
  | { type: "focus_pane"; paneId: string }
  | { type: "focus_next"; currentPaneId?: string }
  | { type: "shutdown" };

export interface TrackerResponse {
  ok: boolean;
  records?: PaneRecord[];
  error?: string;
}

export type TmuxRunner = (args: string[]) => void | Promise<void>;

export interface SessionTrackerOptions {
  now?: () => number;
  staleTimeoutMs?: number;
  tmuxPaneExists?: (paneId: string) => boolean | Promise<boolean>;
  tmuxRunner?: TmuxRunner;
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
  private tmuxRunner: TmuxRunner;
  private focusedPaneId: string | undefined;

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
    this.tmuxRunner =
      options.tmuxRunner ??
      ((args) => {
        execFileSync("tmux", args, { stdio: "ignore" });
      });
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
        nextPaneStateOrder(a.state) - nextPaneStateOrder(b.state) ||
        basename(a.cwd).localeCompare(basename(b.cwd)) ||
        a.paneId.localeCompare(b.paneId),
    );
    if (records.length === 0) return { ok: false, error: "not-found" };
    const currentIndex = records.findIndex(
      (record) => record.paneId === (this.focusedPaneId ?? currentPaneId),
    );
    return this.focusPane(records[(currentIndex + 1) % records.length].paneId);
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
      if (now - record.heartbeatAt > this.staleTimeoutMs || !(await this.tmuxPaneExists(paneId)))
        this.records.delete(paneId);
    }
  }
}

function nextPaneStateOrder(state: TrackerState): number {
  if (state === "needs-permission") return 0;
  if (state === "idle") return 1;
  return 2;
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
  mkdirSync(dirname(socketPath), { recursive: true });
  if (existsSync(socketPath)) unlinkSync(socketPath);
  const server = createServer((socket) => {
    let data = "";
    let handled = false;
    const handleLine = () => {
      if (handled || !data.includes("\n")) return;
      handled = true;
      const request = JSON.parse(data.trim()) as TrackerRequest;
      if (request.type === "shutdown") {
        socket.end(`${JSON.stringify({ ok: true })}\n`, () => server.close());
        return;
      }
      void tracker
        .handle(request)
        .then((response) => socket.end(`${JSON.stringify(response)}\n`))
        .catch((error) => socket.end(`${JSON.stringify({ ok: false, error: String(error) })}\n`));
    };
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      data += chunk;
      handleLine();
    });
    socket.on("end", handleLine);
  });
  const setTimer = options.setInterval ?? setInterval;
  const clearTimer = options.clearInterval ?? clearInterval;
  const pruneTimer = setTimer(
    () => void tracker.prune(),
    options.pruneIntervalMs ?? TRACKER_PRUNE_INTERVAL_MS,
  );
  pruneTimer.unref?.();
  server.on("close", () => {
    clearTimer(pruneTimer);
    try {
      if (existsSync(socketPath)) unlinkSync(socketPath);
    } catch {}
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
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
  if (basename(runtime.execPath).startsWith("bun"))
    return { command: runtime.execPath, args: [servePath] };
  return {
    command: runtime.execPath,
    args: [...runtime.execArgv.filter((arg) => !isDebugExecArgv(arg)), servePath],
  };
}

export function spawnSessionTrackerDaemon(): void {
  const { command, args } = getSessionTrackerDaemonCommand();
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}
