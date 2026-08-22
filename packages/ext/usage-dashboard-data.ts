import { decodeAutoModeUsageRecord } from "./automode/usage.js";
import { decodeSubagentUsageRecord, finiteNumberOrZero } from "./subagents/usage.js";

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

export const AUTO_MODE_PROVIDER = "Auto Mode";

export interface DashboardAuxiliaryUsageEntry {
  sessionId: string;
  message: DashboardSessionMessage;
}

export function formatAutoModeModelLabel(key: string): string {
  try {
    const value: unknown = JSON.parse(key);
    if (
      Array.isArray(value) &&
      value.length === 2 &&
      typeof value[0] === "string" &&
      typeof value[1] === "string"
    ) {
      return `provider: ${value[0]} · model: ${value[1]}`;
    }
  } catch {
    // Fall through for ordinary model names.
  }
  return key;
}

export function decodeAuxiliaryUsageEntry(
  value: unknown,
): DashboardAuxiliaryUsageEntry | undefined {
  const autoModeEntry = decodeAutoModeUsageRecord(value);
  if (autoModeEntry) {
    const usage = autoModeEntry.usage;
    return {
      sessionId: autoModeEntry.parentSessionId,
      message: {
        provider: AUTO_MODE_PROVIDER,
        model: JSON.stringify([autoModeEntry.provider, autoModeEntry.model]),
        cost: usage.cost.total,
        input: usage.input,
        output: usage.output,
        cacheRead: usage.cacheRead,
        cacheWrite: usage.cacheWrite,
        timestamp: autoModeEntry.timestamp,
      },
    };
  }

  const entry = decodeSubagentUsageRecord(value);
  if (!entry?.sessionId || entry.timestamp === undefined || !entry.provider || !entry.model) {
    return undefined;
  }

  return {
    sessionId: entry.sessionId,
    message: {
      provider: entry.provider,
      model: entry.model,
      cost: entry.usage.cost.total,
      input: entry.usage.input,
      output: entry.usage.output,
      cacheRead: entry.usage.cacheRead,
      cacheWrite: entry.usage.cacheWrite,
      timestamp: entry.timestamp,
    },
  };
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
