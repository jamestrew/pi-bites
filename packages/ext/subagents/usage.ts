/** usage.ts — Token usage: shapes, accumulator operators, session-stats readers. */

import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Lifetime usage components, accumulated via `message_end` events. Survives
 * compaction (which replaces session.state.messages and would reset any
 * stats-derived sum). cacheRead is excluded because each turn's cacheRead is
 * the cumulative cached prefix re-read on that one call — summing across
 * turns counts the prefix N times. See issue #38.
 */
export type LifetimeUsage = {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead?: number;
  cost?: number;
};

export type AssistantUsage = LifetimeUsage & {
  provider?: string;
  model?: string;
  timestamp?: number;
};

export type SubagentUsageRecord = {
  type: "subagent_usage";
  subagent: string;
  sessionId: string;
  timestamp: number;
  provider: string;
  model: string;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: { total: number };
  };
};

export type DecodedSubagentUsageRecord = Pick<SubagentUsageRecord, "type" | "subagent" | "usage"> &
  Partial<Pick<SubagentUsageRecord, "sessionId" | "timestamp" | "provider" | "model">>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function finiteNumberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Decode persisted usage, including legacy records without model/session metadata. */
export function decodeSubagentUsageRecord(value: unknown): DecodedSubagentUsageRecord | undefined {
  if (
    !isRecord(value) ||
    value.type !== "subagent_usage" ||
    typeof value.subagent !== "string" ||
    !isRecord(value.usage) ||
    (value.sessionId !== undefined && typeof value.sessionId !== "string") ||
    (value.timestamp !== undefined && typeof value.timestamp !== "number") ||
    (value.provider !== undefined && typeof value.provider !== "string") ||
    (value.model !== undefined && typeof value.model !== "string")
  ) {
    return undefined;
  }

  const usage = value.usage;
  return {
    type: "subagent_usage",
    subagent: value.subagent,
    ...(value.sessionId === undefined ? {} : { sessionId: value.sessionId }),
    ...(value.timestamp === undefined ? {} : { timestamp: finiteNumberOrZero(value.timestamp) }),
    ...(value.provider === undefined ? {} : { provider: value.provider }),
    ...(value.model === undefined ? {} : { model: value.model }),
    usage: {
      input: finiteNumberOrZero(usage.input),
      output: finiteNumberOrZero(usage.output),
      cacheRead: finiteNumberOrZero(usage.cacheRead),
      cacheWrite: finiteNumberOrZero(usage.cacheWrite),
      cost: {
        total: finiteNumberOrZero(isRecord(usage.cost) ? usage.cost.total : usage.cost),
      },
    },
  };
}

function getAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function getSubagentUsageFile(): string {
  return join(getAgentDir(), "pi-bites", "usage", "subagents.jsonl");
}

export async function appendSubagentUsageRecord(record: SubagentUsageRecord): Promise<void> {
  const file = getSubagentUsageFile();
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, JSON.stringify(record) + "\n", "utf8");
}

/** Sum of lifetime usage components, or 0 if undefined. */
export function getLifetimeTotal(u?: LifetimeUsage): number {
  return u ? u.input + u.output + u.cacheWrite : 0;
}

/** Add a usage delta into a target accumulator (mutates target). */
export function addUsage(into: LifetimeUsage, delta: LifetimeUsage): void {
  into.input += delta.input;
  into.output += delta.output;
  into.cacheWrite += delta.cacheWrite;
  if (delta.cacheRead) into.cacheRead = (into.cacheRead ?? 0) + delta.cacheRead;
  if (delta.cost) into.cost = (into.cost ?? 0) + delta.cost;
}

/** Minimal shape we read from upstream `getSessionStats()`. */
export type SessionStatsLike = {
  tokens: { input: number; output: number; cacheWrite: number };
  contextUsage?: { percent: number | null };
};
export type SessionLike = { getSessionStats(): SessionStatsLike };

/**
 * Session-scoped token count: input + output + cacheWrite as reported by
 * upstream `getSessionStats().tokens` for the *current* session window.
 *
 * RESETS at compaction — upstream replaces `session.state.messages` and the
 * stats are derived from that array. For a lifetime total that survives
 * compaction, use `getLifetimeTotal(lifetimeUsage)` instead, which reads
 * from an independent accumulator fed by `message_end` events.
 *
 * Avoids upstream's `tokens.total` field, which sums per-turn `cacheRead`
 * and so counts the cumulative cached prefix N times across N turns
 * (issue #38).
 */
export function getSessionTokens(session: SessionLike | undefined): number {
  if (!session) return 0;
  try {
    const t = session.getSessionStats().tokens;
    return t.input + t.output + t.cacheWrite;
  } catch {
    return 0;
  }
}

/**
 * Context-window utilization (0–100), or null when unavailable
 * (no model contextWindow, or post-compaction before the next response).
 */
export function getSessionContextPercent(session: SessionLike | undefined): number | null {
  if (!session) return null;
  try {
    return session.getSessionStats().contextUsage?.percent ?? null;
  } catch {
    return null;
  }
}
