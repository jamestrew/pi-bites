import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  TAU_STATUS_SCHEMA_VERSION,
  type TauStatusRecord as TauSessionStatus,
} from "#tau/status.js";

// Tau readers should treat heartbeatAt as the process-liveness signal, not
// lastEventAt. Pi refreshes heartbeatAt every 20s; readers should consider a
// session stale only after at least 60s without a heartbeat to allow scheduler
// delays, suspend/resume jitter, and slow filesystems.
export const TAU_HEARTBEAT_INTERVAL_MS = 20_000;
export const TAU_READER_STALE_AFTER_MS = 60_000;

export type TauSessionStatusValue =
  | "idle"
  | "working"
  | "needs-input"
  | "needs-permission"
  | "stopped"
  | "stale"
  | "failed";

export interface TauStatusPaths {
  directory: string;
  statusFile: string;
}

export interface TauStatusSessionMetadata {
  sessionId: string;
  sessionFile: string;
  cwd: string;
}

export interface BuildTauStatusPayloadOptions extends TauStatusSessionMetadata {
  now: number;
  pid: number;
  ppid?: number;
}

export interface TauStatusContext {
  cwd: string;
  sessionManager: {
    getSessionId(): string;
    getSessionFile(): string | undefined;
  };
}

export interface PublishTauStatusOptions {
  now?: () => number;
  pid?: number;
  ppid?: number;
  writeSidecar?: (payload: TauSessionStatus) => Promise<void>;
  onError?: (error: unknown) => void;
}

export interface TauStatusRuntimeOptions extends PublishTauStatusOptions {
  heartbeatIntervalMs?: number;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
}

export interface TauStatusRuntimeEventMetadata {
  currentAction?: string;
  currentTool?: string;
}

export interface TauStatusRuntime {
  start(ctx: TauStatusContext): Promise<void>;
  recordEvent(
    status?: TauSessionStatusValue,
    metadata?: TauStatusRuntimeEventMetadata,
  ): Promise<void>;
  stop(status?: TauSessionStatusValue): Promise<void>;
}

export function getDefaultTauAgentsDir(agentDir = getAgentDir()): string {
  return join(dirname(agentDir), "agents");
}

export function deriveTauStatusPaths(
  sessionId: string,
  agentsDir = getDefaultTauAgentsDir(),
): TauStatusPaths {
  const directory = join(agentsDir, "sessions", sessionId);
  return { directory, statusFile: join(directory, "status.json") };
}

export function buildTauStatusPayload(options: BuildTauStatusPayloadOptions): TauSessionStatus {
  return {
    schemaVersion: TAU_STATUS_SCHEMA_VERSION,
    sessionId: options.sessionId,
    sessionFile: options.sessionFile,
    cwd: options.cwd,
    pid: options.pid,
    ...(options.ppid === undefined ? {} : { ppid: options.ppid }),
    startedAt: options.now,
    heartbeatAt: options.now,
    lastEventAt: options.now,
    status: "idle",
  };
}

export async function writeTauStatusSidecar(
  payload: TauSessionStatus,
  paths = deriveTauStatusPaths(payload.sessionId),
): Promise<void> {
  await mkdir(paths.directory, { recursive: true });

  const tempFile = join(
    paths.directory,
    `.status.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );

  await writeFile(tempFile, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
  await rename(tempFile, paths.statusFile);
}

function logTauStatusPublishError(error: unknown): void {
  console.error(`pi-bites: failed to write Tau status sidecar: ${error}`);
}

async function writeTauStatusSafely(
  payload: TauSessionStatus,
  options: PublishTauStatusOptions,
): Promise<void> {
  try {
    await (options.writeSidecar ?? writeTauStatusSidecar)(payload);
  } catch (error) {
    (options.onError ?? logTauStatusPublishError)(error);
  }
}

export async function publishTauStatusForSession(
  ctx: TauStatusContext,
  options: PublishTauStatusOptions = {},
): Promise<void> {
  const sessionId = ctx.sessionManager.getSessionId();
  const sessionFile = ctx.sessionManager.getSessionFile();
  if (!sessionFile) return;

  const payload = buildTauStatusPayload({
    sessionId,
    sessionFile,
    cwd: ctx.cwd,
    pid: options.pid ?? process.pid,
    ppid: options.ppid ?? process.ppid,
    now: options.now?.() ?? Date.now(),
  });

  await writeTauStatusSafely(payload, options);
}

export function createTauStatusRuntime(options: TauStatusRuntimeOptions = {}): TauStatusRuntime {
  let current: TauSessionStatus | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let writeQueue = Promise.resolve();

  const now = () => options.now?.() ?? Date.now();
  const enqueueWrite = (payload: TauSessionStatus): Promise<void> => {
    const write = writeQueue.then(() => writeTauStatusSafely(payload, options));
    writeQueue = write.catch(() => {});
    return write;
  };
  const writeCurrent = async () => {
    if (current) await enqueueWrite({ ...current });
  };
  const clearHeartbeat = () => {
    if (!heartbeatTimer) return;
    (options.clearInterval ?? clearInterval)(heartbeatTimer);
    heartbeatTimer = undefined;
  };

  return {
    async start(ctx) {
      clearHeartbeat();

      const sessionId = ctx.sessionManager.getSessionId();
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (!sessionFile) return;

      current = buildTauStatusPayload({
        sessionId,
        sessionFile,
        cwd: ctx.cwd,
        pid: options.pid ?? process.pid,
        ppid: options.ppid ?? process.ppid,
        now: now(),
      });
      await writeCurrent();

      heartbeatTimer = (options.setInterval ?? setInterval)(() => {
        if (!current) return;
        current = { ...current, heartbeatAt: now() };
        void writeCurrent();
      }, options.heartbeatIntervalMs ?? TAU_HEARTBEAT_INTERVAL_MS);
      heartbeatTimer.unref?.();
    },

    async recordEvent(status = current?.status ?? "idle", metadata = {}) {
      if (!current) return;
      const eventAt = now();
      const next: TauSessionStatus = {
        ...current,
        status,
        heartbeatAt: eventAt,
        lastEventAt: eventAt,
      };

      if ("currentAction" in metadata) {
        if (metadata.currentAction === undefined) delete next.currentAction;
        else next.currentAction = metadata.currentAction;
      }
      if ("currentTool" in metadata) {
        if (metadata.currentTool === undefined) delete next.currentTool;
        else next.currentTool = metadata.currentTool;
      }

      current = next;
      await writeCurrent();
    },

    async stop(status = "stopped") {
      clearHeartbeat();
      if (!current) return;
      const stoppedAt = now();
      current = { ...current, status, heartbeatAt: stoppedAt, lastEventAt: stoppedAt };
      delete current.currentAction;
      delete current.currentTool;
      await writeCurrent();
      current = undefined;
    },
  };
}

function describeToolAction(toolName: string, input: Record<string, unknown>): string {
  if (toolName === "bash" && typeof input.command === "string" && input.command.trim() !== "") {
    return `Running ${input.command.trim()}`;
  }
  return `Running ${toolName}`;
}

export function registerTauStatusHandlers(
  pi: Pick<ExtensionAPI, "on">,
  statusRuntime: TauStatusRuntime,
): void {
  let agentRunActive = false;
  const activeTools = new Map<string, TauStatusRuntimeEventMetadata>();

  const currentToolMetadata = (): TauStatusRuntimeEventMetadata => {
    const last = Array.from(activeTools.values()).at(-1);
    return last ?? { currentAction: undefined, currentTool: undefined };
  };

  pi.on("session_start", async (_event, ctx) => {
    await statusRuntime.start(ctx);
  });

  pi.on("agent_start", async () => {
    agentRunActive = true;
    await statusRuntime.recordEvent("working");
  });

  pi.on("tool_call", async (event) => {
    const metadata = {
      currentAction: describeToolAction(event.toolName, event.input),
      currentTool: event.toolName,
    };
    activeTools.set(event.toolCallId, metadata);
    await statusRuntime.recordEvent("working", metadata);
  });

  pi.on("tool_result", async (event) => {
    activeTools.delete(event.toolCallId);
    const metadata = currentToolMetadata();
    await statusRuntime.recordEvent(agentRunActive ? "working" : "idle", metadata);
  });

  pi.on("agent_end", async () => {
    agentRunActive = false;
    activeTools.clear();
    await statusRuntime.recordEvent("idle", { currentAction: undefined, currentTool: undefined });
  });

  pi.on("turn_end", async () => {
    if (!agentRunActive)
      await statusRuntime.recordEvent("idle", { currentAction: undefined, currentTool: undefined });
  });

  pi.on("session_shutdown", async () => {
    await statusRuntime.stop("stopped");
  });
}

export default function registerTau(pi: ExtensionAPI): void {
  const statusRuntime = createTauStatusRuntime();
  registerTauStatusHandlers(pi, statusRuntime);

  // /agents -----------------------------------------------------------------
  pi.registerCommand("agents", {
    description:
      "Return to Tau or another waiting parent by cooperatively shutting down this Pi session",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        "Shutting down Pi. If this session was launched from Tau or another waiting parent, control will return there.",
        "info",
      );
      ctx.shutdown();
    },
  });
}
