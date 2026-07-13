import { finiteNumberOrZero } from "./subagents/usage.js";

export interface DashboardSessionMessage {
  provider: string;
  model: string;
  cost: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  timestamp: number;
}

export type DashboardSessionEntry =
  | { type: "session"; sessionId: string }
  | { type: "message"; message: DashboardSessionMessage };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function decodeSessionUsageEntry(value: unknown): DashboardSessionEntry | undefined {
  if (!isRecord(value)) return undefined;
  if (value.type === "session") {
    return typeof value.id === "string" ? { type: "session", sessionId: value.id } : undefined;
  }
  if (value.type !== "message" || !isRecord(value.message)) return undefined;
  const message = value.message;
  if (
    message.role !== "assistant" ||
    typeof message.provider !== "string" ||
    typeof message.model !== "string" ||
    !isRecord(message.usage)
  ) {
    return undefined;
  }
  const usage = message.usage;
  const fallbackTimestamp =
    typeof value.timestamp === "string" ? finiteNumberOrZero(Date.parse(value.timestamp)) : 0;
  return {
    type: "message",
    message: {
      provider: message.provider,
      model: message.model,
      cost: isRecord(usage.cost) ? finiteNumberOrZero(usage.cost.total) : 0,
      input: finiteNumberOrZero(usage.input),
      output: finiteNumberOrZero(usage.output),
      cacheRead: finiteNumberOrZero(usage.cacheRead),
      cacheWrite: finiteNumberOrZero(usage.cacheWrite),
      timestamp: finiteNumberOrZero(message.timestamp) || fallbackTimestamp,
    },
  };
}
