import { type AgentRecord } from "./types.js";
import { getLifetimeTotal } from "./usage.js";

/** Helper: build event data for lifecycle events from an AgentRecord. */
export function buildEventData(record: AgentRecord) {
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
    tokens,
  };
}
