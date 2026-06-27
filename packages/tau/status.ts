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
  /**
   * Human-readable session title shown by Tau dashboards. Pi may provide this
   * natively in the future; until then the Tau extension writes a generated or
   * deterministic fallback title here from the first user input.
   */
  title?: string;
  currentAction?: string;
  currentTool?: string;
  lastError?: string;
  model?: string;
}
