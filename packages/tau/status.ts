export const TAU_STATUS_SCHEMA_VERSION = 1;
export const TAU_STATUS_VALUES = [
  "idle",
  "working",
  "needs-input",
  "needs-permission",
  "stopped",
  "stale",
  "failed",
] as const;

export type TauStatusValue = (typeof TAU_STATUS_VALUES)[number];

export interface TauStatusRecord {
  schemaVersion: typeof TAU_STATUS_SCHEMA_VERSION;
  sessionId: string;
  sessionFile: string;
  cwd: string;
  pid: number;
  ppid?: number;
  tty?: string;
  startedAt: number;
  heartbeatAt: number;
  lastEventAt: number;
  status: TauStatusValue;
  title?: string;
  currentAction?: string;
  currentTool?: string;
  lastError?: string;
  model?: string;
}
