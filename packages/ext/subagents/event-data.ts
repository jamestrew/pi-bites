import { type AgentAbort, type AgentFailure, type AgentRecord } from "./types.js";
import { getLifetimeTotal } from "./usage.js";

export type AgentEventData = {
  id: string;
  type: string;
  description: string;
  result?: string;
  error?: string;
  status: string;
  toolUses: number;
  durationMs: number;
  failureHistory?: AgentFailure[];
  abort?: AgentAbort;
  tokens?: {
    input: number;
    output: number;
    total: number;
  };
};

/** Helper: build event data for lifecycle events from an AgentRecord. */
export function buildEventData(record: AgentRecord): AgentEventData {
  const durationMs = record.completedAt
    ? record.completedAt - record.startedAt
    : Date.now() - record.startedAt;
  // All three fields are lifetime-accumulated (Σ over every assistant message_end),
  // so they survive compaction together — input + output ≤ total always.
  // tokens is omitted when nothing was ever produced (e.g. agent errored before
  // any message_end fired), preserving prior payload shape.
  const u = record.lifetimeUsage;
  const total = getLifetimeTotal(u);
  const tokens = total > 0 ? { input: u.input, output: u.output, total } : undefined;
  return {
    id: record.id,
    type: record.type,
    description: record.description,
    result: record.result,
    error: record.error,
    status: record.status,
    toolUses: record.toolUses,
    durationMs,
    ...(record.failureHistory.length > 0
      ? { failureHistory: record.failureHistory.map((failure) => ({ ...failure })) }
      : {}),
    ...(record.abort ? { abort: { ...record.abort } } : {}),
    tokens,
  };
}
