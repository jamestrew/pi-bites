/** Shared formatting/types for subagent inline results, Fleet, and notifications. */

import { resolveAgent } from "../agent-types.js";
import type { AgentInvocation, ThinkingLevel } from "../types.js";
import { type LifetimeUsage } from "../usage.js";

// ---- Types ----

export type Theme = {
  fg(color: string, text: string): string;
  bold(text: string): string;
};

/** Metadata attached to spawn_agent results for custom rendering. */
export interface AgentDetails {
  displayName: string;
  description: string;
  subagentType: string;
  toolUses: number;
  tokens: string;
  durationMs: number;
  status: "queued" | "running" | "completed" | "stopped" | "error";
  /** Human-readable description of what the agent is currently doing. */
  activity?: string;
  /** Current spinner frame index (for animated running indicator). */
  spinnerFrame?: number;
  /** Full effective provider/model identifier. */
  modelName?: string;
  /** Effective reasoning level persisted for restored call rendering. */
  thinking?: ThinkingLevel;
  /** Notable config tags (e.g. ["thinking: high", "isolated"]). */
  tags?: string[];
  /** Current turn count. */
  turnCount?: number;
  agentId?: string;
  error?: string;
  toolCalls?: string[];
  lifetimeUsage?: LifetimeUsage;
}

// ---- Formatting helpers ----

/** Format a token count compactly: "33.8k token", "1.2M token". */
export function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M token`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k token`;
  return `${count} token`;
}

/** Format turn count. */
export function formatTurns(turnCount: number): string {
  return `↻${turnCount}`;
}

/** Format milliseconds as human-readable duration. */
export function formatMs(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Get the display name for an embedded agent type. */
export function getDisplayName(type: string): string {
  const { config } = resolveAgent(type);
  return config.displayName ?? config.name;
}

/** Format effective invocation metadata for user-facing displays. */
export function buildInvocationTags(invocation: AgentInvocation | undefined): {
  modelName?: string;
  tags: string[];
} {
  const tags: string[] = [];
  if (!invocation) return { tags };
  if (invocation.thinking) tags.push(`thinking: ${invocation.thinking}`);
  if (invocation.isolated) tags.push("isolated");
  return { modelName: invocation.modelName, tags };
}
