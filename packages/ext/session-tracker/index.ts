import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createConnection, createServer, type Server } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type SessionTrackerState = "idle" | "working" | "needs-permission" | "stopped";

export interface SessionTrackerRecord {
  paneId: string;
  cwd: string;
  runtimeId: string;
  sequence: number;
  state: SessionTrackerState;
  reportedAt: number;
  sessionId?: string;
  sessionFile?: string;
}

export type SessionTrackerRequest =
  | { type: "report"; record: SessionTrackerRecord }
  | { type: "snapshot" };

export type SessionTrackerResponse =
  | { ok: true }
  | { ok: true; panes: SessionTrackerRecord[] }
  | { ok: false; error: string };

export class SessionTrackerStore {
  private readonly panes = new Map<string, SessionTrackerRecord>();

  report(record: SessionTrackerRecord): void {
    this.panes.set(record.paneId, { ...record });
  }

  snapshot(): SessionTrackerRecord[] {
    return [...this.panes.values()].sort((a, b) => a.paneId.localeCompare(b.paneId));
  }
}

export function getSessionTrackerSocketPath(agentDir = getAgentDir()): string {
  return join(agentDir, "session-tracker.sock");
}

export function createSessionTrackerServer(store = new SessionTrackerStore()): Server {
  return createServer((socket) => {
    let input = "";
    socket.setEncoding("utf-8");
    socket.on("data", (chunk) => {
      input += chunk;
      const lineEnd = input.indexOf("\n");
      if (lineEnd === -1) return;

      const line = input.slice(0, lineEnd);
      let response: SessionTrackerResponse;
      try {
        const request = JSON.parse(line) as SessionTrackerRequest;
        if (request.type === "report") {
          store.report(request.record);
          response = { ok: true };
        } else if (request.type === "snapshot") {
          response = { ok: true, panes: store.snapshot() };
        } else {
          response = { ok: false, error: "unknown request" };
        }
      } catch (error) {
        response = { ok: false, error: String(error) };
      }
      socket.end(`${JSON.stringify(response)}\n`);
    });
  });
}

async function removeStaleSocket(socketPath: string): Promise<void> {
  if (!existsSync(socketPath)) return;
  try {
    const response = await sendSessionTrackerRequest({ type: "snapshot" }, socketPath);
    if (response.ok) throw new Error(`session tracker daemon already listening at ${socketPath}`);
  } catch (error) {
    if (!shouldStartDaemon(error)) throw error;
    if (existsSync(socketPath)) unlinkSync(socketPath);
  }
}

export async function startSessionTrackerDaemon(
  socketPath = getSessionTrackerSocketPath(),
): Promise<Server> {
  await mkdir(dirname(socketPath), { recursive: true });
  await removeStaleSocket(socketPath);
  const server = createSessionTrackerServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

export function sendSessionTrackerRequest(
  request: SessionTrackerRequest,
  socketPath = getSessionTrackerSocketPath(),
): Promise<SessionTrackerResponse> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let output = "";
    socket.setEncoding("utf-8");
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk) => (output += chunk));
    socket.on("error", reject);
    socket.on("end", () => {
      try {
        resolve(JSON.parse(output.trim()) as SessionTrackerResponse);
      } catch (error) {
        reject(error);
      }
    });
  });
}

function shouldStartDaemon(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  return code === "ENOENT" || code === "ECONNREFUSED";
}

interface ClientDeps {
  socketPath: string;
  send: (request: SessionTrackerRequest, socketPath: string) => Promise<SessionTrackerResponse>;
  spawnDaemon: () => void;
  waitAfterSpawn: () => Promise<void>;
  now: () => number;
  runtimeId: string;
  daemonStartupTimeoutMs: number;
  retryIntervalMs: number;
}

export interface SessionTrackerRuntimeOptions extends Partial<ClientDeps> {
  paneId?: string;
}

function createDeps(options: SessionTrackerRuntimeOptions): ClientDeps {
  const socketPath = options.socketPath ?? getSessionTrackerSocketPath();
  return {
    socketPath,
    send: options.send ?? sendSessionTrackerRequest,
    spawnDaemon:
      options.spawnDaemon ??
      (() => {
        const child = spawn(
          process.execPath,
          [fileURLToPath(import.meta.url), "daemon", socketPath],
          {
            detached: true,
            stdio: "ignore",
          },
        );
        child.unref();
      }),
    waitAfterSpawn: options.waitAfterSpawn ?? (() => Promise.resolve()),
    now: options.now ?? Date.now,
    runtimeId: options.runtimeId ?? randomUUID(),
    daemonStartupTimeoutMs: options.daemonStartupTimeoutMs ?? 1_000,
    retryIntervalMs: options.retryIntervalMs ?? 25,
  };
}

export function createSessionTrackerRuntime(options: SessionTrackerRuntimeOptions = {}) {
  const deps = createDeps(options);
  const paneId = "paneId" in options ? options.paneId : process.env.TMUX_PANE;
  let sequence = 0;
  let current: Omit<SessionTrackerRecord, "sequence" | "reportedAt" | "state"> | undefined;
  let state: SessionTrackerState = "idle";
  let agentRunActive = false;
  let permissionGateActive = false;

  const delay = () => new Promise((resolve) => setTimeout(resolve, deps.retryIntervalMs));

  const sendWithDaemon = async (request: SessionTrackerRequest) => {
    try {
      return await deps.send(request, deps.socketPath);
    } catch (error) {
      if (!shouldStartDaemon(error)) throw error;
      deps.spawnDaemon();
      await deps.waitAfterSpawn();
      const deadline = Date.now() + deps.daemonStartupTimeoutMs;
      let lastError = error;
      while (Date.now() < deadline) {
        try {
          return await deps.send(request, deps.socketPath);
        } catch (retryError) {
          if (!shouldStartDaemon(retryError)) throw retryError;
          lastError = retryError;
          await delay();
        }
      }
      throw lastError;
    }
  };

  const report = async () => {
    if (!current) return;
    const record: SessionTrackerRecord = {
      ...current,
      state,
      sequence: ++sequence,
      reportedAt: deps.now(),
    };
    await sendWithDaemon({ type: "report", record });
  };

  return {
    get sequence() {
      return sequence;
    },
    async start(ctx: {
      cwd: string;
      sessionManager?: { getSessionId(): string; getSessionFile(): string | undefined };
    }) {
      if (!paneId) return;
      current = {
        paneId,
        cwd: ctx.cwd,
        runtimeId: deps.runtimeId,
        sessionId: ctx.sessionManager?.getSessionId(),
        sessionFile: ctx.sessionManager?.getSessionFile(),
      };
      await report();
      await sendWithDaemon({ type: "snapshot" });
    },
    async setState(next: SessionTrackerState) {
      state = next;
      await report();
    },
    async agentStart() {
      agentRunActive = true;
      await this.setState("working");
    },
    async agentEnd() {
      agentRunActive = false;
      await this.setState("idle");
    },
    async permissionNeeded() {
      permissionGateActive = true;
      await this.setState("needs-permission");
    },
    async permissionResolved() {
      permissionGateActive = false;
      await this.setState(agentRunActive ? "working" : "idle");
    },
    async toolCall() {
      await this.setState(permissionGateActive ? "needs-permission" : "working");
    },
  };
}

export default function registerSessionTracker(pi: Pick<ExtensionAPI, "on" | "events">): void {
  const runtime = createSessionTrackerRuntime();
  pi.on("session_start", async (_event, ctx) => runtime.start(ctx));
  pi.on("agent_start", async () => runtime.agentStart());
  pi.on("tool_call", async () => runtime.toolCall());
  pi.events.on("bites:bash_gate", async () => runtime.permissionNeeded());
  pi.events.on("bites:bash_gate_resolved", async () => runtime.permissionResolved());
  pi.on("agent_end", async () => runtime.agentEnd());
  pi.on("session_shutdown", async () => runtime.setState("stopped"));
}

if (process.argv[2] === "daemon") {
  void startSessionTrackerDaemon(process.argv[3]).catch((error) => {
    console.error(`pi-bites: session tracker daemon failed: ${error}`);
    process.exit(1);
  });
}
