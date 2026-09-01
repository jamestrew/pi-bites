/**
 * types.ts — Type definitions for the subagent system.
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { DiagnosticErrorInfo } from "./diagnostics.js";
import type { LifetimeUsage } from "./usage.js";

export type { ThinkingLevel };

const THINKING_LEVELS: ReadonlySet<string> = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && THINKING_LEVELS.has(value);
}

/** Agent type: any string name (built-in defaults or user-defined). */
export type SubagentType = string;

export const MISSING_FINAL_RESPONSE_ERROR = "Agent completed without a final response.";

export function isMissingFinalResponse(status: string, result?: string): boolean {
  return status === "completed" && !result?.trim();
}

/** Isolation mode for agent execution. */
export type IsolationMode = "worktree";

export type BashGatePolicy = "deny" | "prompt";

/** Unified agent configuration — used for both default and user-defined agents. */
export interface AgentConfig {
  name: string;
  displayName?: string;
  description: string;
  builtinToolNames?: string[];
  /** Raw `ext:` selector entries from the `tools:` CSV, e.g. ["ext:foo", "ext:bar/x"].
   * Presence of any entry flips extension tools to an explicit allowlist. */
  extSelectors?: string[];
  /** Tool denylist — these tools are removed even if `builtinToolNames` or extensions include them. */
  disallowedTools?: string[];
  /** true = inherit all, string[] = only listed, false = none */
  extensions: true | string[] | false;
  /** Extension-name denylist applied after the `extensions:` include set. Exclude wins.
   * Plain canonical names only (case-insensitive); no paths, no wildcard. */
  excludeExtensions?: string[];
  /** Whether Pi should discover skills normally for this subagent. */
  skills: boolean;
  model?: string;
  thinking?: string;
  /** Persist this subagent as a normal pi session instead of keeping it in memory only. */
  persistSession?: boolean;
  /** Optional session directory used when persistSession is true. Omitted = pi's normal session location. */
  sessionDir?: string;
  systemPrompt: string;
  promptMode: "replace" | "append";
  /** Default for spawn: fork parent conversation. undefined = caller decides. */
  inheritContext?: boolean;
  /** Default for spawn: no extension tools. undefined = caller decides. */
  isolated?: boolean;
  /** Gated bash policy for this subagent. */
  bashGatePolicy?: BashGatePolicy;
  /** Isolation mode — "worktree" runs the agent in a temporary git worktree */
  isolation?: IsolationMode;
  /** true = this is an embedded default agent (informational) */
  isDefault?: boolean;
  /** false = agent is hidden from the registry */
  enabled?: boolean;
  /** Where this agent was loaded from */
  source?: "default" | "project" | "global";
}

export interface AgentRecord {
  id: string;
  type: SubagentType;
  parentSessionId: string;
  /** Raw task supplied by the caller, without inherited parent context. */
  prompt: string;
  description: string;
  status: "queued" | "running" | "completed" | "stopped" | "error";
  result?: string;
  error?: string;
  toolUses: number;
  /** Bounded tool-call summaries retained for expanded completion rendering. */
  toolCalls: string[];
  omittedToolCalls: number;
  startedAt: number;
  completedAt?: number;
  session?: AgentSession;
  abortController?: AbortController;
  promise?: Promise<string>;
  /** Steering messages queued before the session was ready. */
  pendingSteers?: string[];
  /** Message to resume with after cancelling the current operation. */
  pendingCancelSteer?: string;
  /** Worktree info if the agent is running in an isolated worktree. */
  worktree?: { path: string; branch: string; baseSha: string; workPath: string };
  /** Worktree cleanup result after agent completion. */
  worktreeResult?: { hasChanges: boolean; branch?: string };
  /** The tool_use_id from the original Agent tool call. */
  toolCallId?: string;
  /**
   * Lifetime usage breakdown, accumulated via `message_end` events. Survives
   * compaction. Total = input + output + cacheWrite (cacheRead deliberately
   * excluded — see issue #38). Initialized to zeros at spawn.
   */
  lifetimeUsage: LifetimeUsage;
  /** Number of times this agent's session has compacted. Initialized to 0 at spawn. */
  compactionCount: number;
  /** Resolved spawn params, captured for UI display. Fixed at spawn time. */
  invocation?: AgentInvocation;
  /** Chronological provider/runner failures, retained so a later abort cannot hide an earlier cause. */
  failureHistory: AgentFailure[];
  /** Explicit cancellation initiated by the subagent manager, if any. */
  abort?: AgentAbort;
}

export interface AgentFailure {
  timestamp: number;
  phase: "assistant" | "runner" | "manager";
  message: string;
  name?: string;
  stop_reason?: string;
  provider?: string;
  model?: string;
  request_index?: number;
  manager_signal_aborted?: boolean;
  error_details?: DiagnosticErrorInfo;
  diagnostics?: unknown[];
}

export interface AgentAbort {
  timestamp: number;
  source: "stop" | "cancel_and_steer" | "shutdown";
  reason?: string;
}

export interface AgentInvocation {
  /** Full effective provider/model identifier. */
  modelName?: string;
  thinking?: ThinkingLevel;
  isolated?: boolean;
  inheritContext?: boolean;
  isolation?: IsolationMode;
}

export interface WaitAgentResult {
  id: string;
  type: string;
  description: string;
  status: AgentRecord["status"];
  result?: string;
  error?: string;
  tool_uses: number;
  duration_ms: number;
  total_tokens: number;
  lifetime_usage?: LifetimeUsage;
  /** Chronological errors for terminal agents; catches an original error later masked by abort. */
  failure_history?: AgentFailure[];
  /** Manager-initiated cancellation, when it explains the terminal abort. */
  abort?: AgentAbort;
  /** UI-only invocation metadata; omitted from the tool's text result. */
  model_name?: string;
  thinking?: ThinkingLevel;
  /** UI-only tool-call summaries; omitted from the tool's text result. */
  tool_calls?: string[];
}

export interface WaitAgentSender {
  id: string;
  type: string;
  title: string;
  /** UI-only invocation metadata; omitted from the tool's text result. */
  model_name?: string;
  thinking?: ThinkingLevel;
}

export type WaitAgentOutcome =
  | {
      outcome: "message";
      timed_out: false;
      sender: WaitAgentSender;
      message: string;
      agents: WaitAgentResult[];
    }
  | {
      outcome: "terminal" | "cancelled";
      timed_out: false;
      agents: WaitAgentResult[];
    }
  | {
      outcome: "timeout";
      timed_out: true;
      agents: WaitAgentResult[];
    }
  | {
      /** Another delivery path already owns the result; this wait must not duplicate it. */
      outcome: "delivery_claimed";
      timed_out: false;
      agents: WaitAgentResult[];
    }
  | {
      outcome: "error";
      timed_out: false;
      message: string;
      agents: WaitAgentResult[];
    };

type WaitAgentTiming = {
  wait_started_at?: number;
  wait_ended_at?: number;
  /** Only present when the caller explicitly configured a timeout. */
  timeout_ms?: number;
};

export type WaitAgentDetails = WaitAgentTiming &
  (WaitAgentOutcome | { outcome: "waiting"; timed_out: false; agents: WaitAgentResult[] });

/** Details attached to custom notification messages for visual rendering. */
export interface NotificationDetails {
  id: string;
  description: string;
  status: string;
  toolUses: number;
  turnCount: number;
  totalTokens: number;
  durationMs: number;
  error?: string;
  result?: string;
  /** Legacy details restored from sessions created before expandable notifications. */
  resultPreview?: string;
  /** Additional agents in a group notification. */
  others?: NotificationDetails[];
}

export interface EnvInfo {
  isGitRepo: boolean;
  branch: string;
  platform: string;
}
