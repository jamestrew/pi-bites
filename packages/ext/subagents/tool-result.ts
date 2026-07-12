import { buildDoneStats } from "./ui/tool-call-format.js";
import { type AgentDetails, formatTokens } from "./ui/agent-format.js";
import { getLifetimeTotal, type LifetimeUsage } from "./usage.js";

/** Tool execute return value for a text response. */
export function textResult(msg: string, details?: AgentDetails) {
  return { content: [{ type: "text" as const, text: msg }], details: details as any };
}

/** Format an agent's lifetime token total, or "" when zero. */
export function formatLifetimeTokens(o: { lifetimeUsage: LifetimeUsage }): string {
  const t = getLifetimeTotal(o.lifetimeUsage);
  return t > 0 ? formatTokens(t) : "";
}

/** Build AgentDetails from a base + record-specific fields. */
export function buildDetails(
  base: Pick<AgentDetails, "displayName" | "description" | "subagentType" | "modelName" | "tags">,
  record: {
    toolUses: number;
    startedAt: number;
    completedAt?: number;
    status: string;
    error?: string;
    id?: string;
    session?: any;
    lifetimeUsage: LifetimeUsage;
  },
  activity?: { turnCount?: number; toolCalls?: string[] },
  overrides?: Partial<AgentDetails>,
): AgentDetails {
  return {
    ...base,
    toolUses: record.toolUses,
    tokens: formatLifetimeTokens(record),
    turnCount: activity?.turnCount,
    durationMs: (record.completedAt ?? Date.now()) - record.startedAt,
    status: record.status as AgentDetails["status"],
    agentId: record.id,
    error: record.error,
    toolCalls: activity?.toolCalls,
    lifetimeUsage: record.lifetimeUsage,
    ...overrides,
  };
}

export function doneStats(toolCalls: number, usage: LifetimeUsage, durationMs?: number): string {
  return buildDoneStats(toolCalls, usage, durationMs);
}
