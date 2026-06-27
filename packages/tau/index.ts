import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  TAU_STATUS_SCHEMA_VERSION,
  TAU_STATUS_VALUES,
  type TauStatusRecord,
  type TauStatusValue,
} from "./status.js";

export { TAU_STATUS_SCHEMA_VERSION, type TauStatusRecord, type TauStatusValue } from "./status.js";
export {
  TAU_DASHBOARD_TITLE,
  buildTauDashboardView,
  handleTauDashboardKey,
  moveTauDashboardSelection,
  reconcileTauDashboardSelection,
  renderTauDashboard,
  type ReconcileTauDashboardSelectionOptions,
  type RenderTauDashboardOptions,
  type TauDashboardRow,
  type TauDashboardControllerEffect,
  type TauDashboardControllerResult,
  type TauDashboardControllerState,
  type TauDashboardRowKind,
  type TauDashboardSelectionState,
  type TauDashboardViewModel,
} from "./dashboard.js";

export const DEFAULT_TAU_STALE_AFTER_MS = 60_000;

export interface TauDashboardSession {
  sessionId: string;
  sessionFile: string;
  cwd: string;
  pid: number;
  ppid?: number;
  title?: string;
  currentAction?: string;
  currentTool?: string;
  lastError?: string;
  model?: string;
  startedAt: number;
  heartbeatAt: number;
  lastEventAt: number;
  activityAt: number;
  sourceStatus: TauStatusValue;
  state: TauStatusValue;
  isLive: boolean;
  isStale: boolean;
  statusFile: string;
}

export type TauStatusLoadIssueKind =
  | "missing-status"
  | "invalid-json"
  | "unsupported-schema"
  | "invalid-record"
  | "read-error";

export interface TauStatusLoadIssue {
  kind: TauStatusLoadIssueKind;
  statusFile: string;
  message: string;
}

export interface LoadTauDashboardSessionsOptions {
  agentsDir?: string;
  now?: () => number;
  staleAfterMs?: number;
  isPidLive?: (pid: number) => boolean;
}

export interface LoadTauDashboardSessionsResult {
  sessions: TauDashboardSession[];
  issues: TauStatusLoadIssue[];
}

const STATUS_VALUES = new Set<TauStatusValue>(TAU_STATUS_VALUES);

export function getDefaultTauAgentsDir(): string {
  return join(homedir(), ".pi", "agents");
}

export function getTauSessionsDir(agentsDir = getDefaultTauAgentsDir()): string {
  return join(agentsDir, "sessions");
}

function defaultIsPidLive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function requiredString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function requiredNumber(value: unknown): value is number {
  return Number.isFinite(value);
}

function parseTauStatusRecord(value: unknown): TauStatusRecord | string {
  if (!value || typeof value !== "object") return "record must be an object";
  const record = value as Record<string, unknown>;

  if (record.schemaVersion !== TAU_STATUS_SCHEMA_VERSION) {
    return `unsupported schemaVersion ${String(record.schemaVersion)}`;
  }

  const missing = [
    ["sessionId", requiredString(record.sessionId)],
    ["sessionFile", requiredString(record.sessionFile)],
    ["cwd", requiredString(record.cwd)],
    ["pid", requiredNumber(record.pid)],
    ["startedAt", requiredNumber(record.startedAt)],
    ["heartbeatAt", requiredNumber(record.heartbeatAt)],
    ["lastEventAt", requiredNumber(record.lastEventAt)],
    [
      "status",
      typeof record.status === "string" && STATUS_VALUES.has(record.status as TauStatusValue),
    ],
  ]
    .filter(([, ok]) => !ok)
    .map(([field]) => field);

  if (missing.length > 0) return `missing or invalid required fields: ${missing.join(", ")}`;

  return record as unknown as TauStatusRecord;
}

function toDashboardSession(
  record: TauStatusRecord,
  statusFile: string,
  now: number,
  staleAfterMs: number,
  isPidLive: (pid: number) => boolean,
): TauDashboardSession {
  const activityAt = Math.max(record.lastEventAt, record.heartbeatAt);
  const pidLive = isPidLive(record.pid);
  const heartbeatFresh = now - record.heartbeatAt <= staleAfterMs;
  const isStale = record.status !== "stopped" && (!pidLive || !heartbeatFresh);
  const state = isStale ? "stale" : record.status;

  return {
    sessionId: record.sessionId,
    sessionFile: record.sessionFile,
    cwd: record.cwd,
    pid: record.pid,
    ppid: record.ppid,
    title: record.title,
    currentAction: record.currentAction,
    currentTool: record.currentTool,
    lastError: record.lastError,
    model: record.model,
    startedAt: record.startedAt,
    heartbeatAt: record.heartbeatAt,
    lastEventAt: record.lastEventAt,
    activityAt,
    sourceStatus: record.status,
    state,
    isLive: state !== "stale" && state !== "stopped" && pidLive,
    isStale,
    statusFile,
  };
}

export async function loadTauDashboardSessions(
  options: LoadTauDashboardSessionsOptions = {},
): Promise<LoadTauDashboardSessionsResult> {
  const sessionsDir = getTauSessionsDir(options.agentsDir);
  const issues: TauStatusLoadIssue[] = [];
  const sessions: TauDashboardSession[] = [];
  const now = options.now?.() ?? Date.now();
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_TAU_STALE_AFTER_MS;
  const isPidLive = options.isPidLive ?? defaultIsPidLive;

  let entries;
  try {
    entries = await readdir(sessionsDir, { withFileTypes: true });
  } catch (error) {
    issues.push({
      kind: "read-error",
      statusFile: sessionsDir,
      message: `failed to read Tau sessions directory: ${String(error)}`,
    });
    return { sessions, issues };
  }

  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const statusFile = join(sessionsDir, entry.name, "status.json");
        let text: string;
        try {
          text = await readFile(statusFile, "utf-8");
        } catch (error: unknown) {
          const code = (error as { code?: unknown }).code;
          issues.push({
            kind: code === "ENOENT" ? "missing-status" : "read-error",
            statusFile,
            message: `failed to read status.json: ${String(error)}`,
          });
          return;
        }

        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch (error) {
          issues.push({ kind: "invalid-json", statusFile, message: String(error) });
          return;
        }

        const record = parseTauStatusRecord(json);
        if (typeof record === "string") {
          issues.push({
            kind: record.startsWith("unsupported schemaVersion")
              ? "unsupported-schema"
              : "invalid-record",
            statusFile,
            message: record,
          });
          return;
        }

        sessions.push(toDashboardSession(record, statusFile, now, staleAfterMs, isPidLive));
      }),
  );

  sessions.sort((a, b) => b.activityAt - a.activityAt || a.sessionId.localeCompare(b.sessionId));
  return { sessions, issues };
}
