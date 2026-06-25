import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const TAU_STATUS_SCHEMA_VERSION = 1;

export type TauSessionStatusValue =
  | "idle"
  | "working"
  | "needs-input"
  | "needs-permission"
  | "stopped"
  | "stale"
  | "failed";

export interface TauSessionStatus {
  schemaVersion: typeof TAU_STATUS_SCHEMA_VERSION;
  sessionId: string;
  sessionFile: string;
  cwd: string;
  pid: number;
  ppid?: number;
  startedAt: number;
  heartbeatAt: number;
  lastEventAt: number;
  status: TauSessionStatusValue;
}

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

  try {
    await (options.writeSidecar ?? writeTauStatusSidecar)(payload);
  } catch (error) {
    (options.onError ?? logTauStatusPublishError)(error);
  }
}

export default function registerTauStatus(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    await publishTauStatusForSession(ctx);
  });
}
