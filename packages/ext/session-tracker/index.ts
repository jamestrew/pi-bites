import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  getTrackerSocketPath,
  requestTracker,
  spawnSessionTrackerDaemon,
  TRACKER_HEARTBEAT_INTERVAL_MS,
  type PaneRecord,
  type TrackerState,
} from "../../session-tracker/index.js";

interface TrackerContext {
  cwd: string;
  sessionManager?: { getSessionId?: () => string };
}

export interface TrackerRuntimeOptions {
  runtimeId?: string;
  paneId?: string;
  socketPath?: string;
  heartbeatIntervalMs?: number;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  send?: typeof requestTracker;
  spawnDaemon?: typeof spawnSessionTrackerDaemon;
  now?: () => number;
}

export function createSessionTrackerRuntime(options: TrackerRuntimeOptions = {}) {
  const runtimeId = options.runtimeId ?? randomUUID();
  const paneId = options.paneId ?? process.env.TMUX_PANE;
  const socketPath = options.socketPath ?? getTrackerSocketPath();
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? TRACKER_HEARTBEAT_INTERVAL_MS;
  const setTimer = options.setInterval ?? setInterval;
  const clearTimer = options.clearInterval ?? clearInterval;
  const send = options.send ?? requestTracker;
  const spawnDaemon = options.spawnDaemon ?? spawnSessionTrackerDaemon;
  const now = options.now ?? Date.now;
  let seq = 0;
  let state: TrackerState = "idle";
  let ctx: TrackerContext | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;

  const record = (): PaneRecord | undefined => {
    if (!paneId || !ctx) return undefined;
    const sessionId = ctx.sessionManager?.getSessionId?.();
    return {
      paneId,
      cwd: ctx.cwd,
      runtimeId,
      seq: ++seq,
      state,
      heartbeatAt: now(),
      ...(sessionId ? { sessionId } : {}),
    };
  };

  const call = async (request: Parameters<typeof send>[1]) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await send(socketPath, request);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if ((code !== "ENOENT" && code !== "ECONNREFUSED") || attempt >= 3) throw error;
        if (attempt === 0) spawnDaemon();
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  };

  const report = async (type: "report" | "heartbeat") => {
    const current = record();
    if (current) await call({ type, record: current });
  };

  return {
    async start(startCtx: TrackerContext) {
      ctx = startCtx;
      await report("report");
      timer = setTimer(() => void report("heartbeat"), heartbeatIntervalMs);
      timer.unref?.();
    },
    async setState(next: TrackerState) {
      state = next;
      await report("report");
    },
    async stop(release = false) {
      if (timer) clearTimer(timer);
      timer = undefined;
      if (release && paneId) await call({ type: "release", paneId, runtimeId });
      ctx = undefined;
    },
  };
}

export default function registerSessionTracker(pi: ExtensionAPI): void {
  const runtime = createSessionTrackerRuntime();
  pi.on("session_start", async (_event, ctx) => runtime.start(ctx));
  pi.on("agent_start", async () => runtime.setState("working"));
  pi.events?.on("bites:bash_gate", async () => runtime.setState("needs-permission"));
  pi.events?.on("bites:bash_gate_resolved", async () => runtime.setState("working"));
  pi.on("agent_end", async () => runtime.setState("idle"));
  pi.on("turn_end", async () => runtime.setState("idle"));
  pi.on("session_shutdown", async (event) => runtime.stop(event.reason === "quit"));
}
