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

export const SUBAGENT_TYPES = ["default", "worker", "explorer"] as const;
export type SubagentType = (typeof SUBAGENT_TYPES)[number];

export const MISSING_FINAL_RESPONSE_ERROR = "Agent completed without a final response.";

export function isMissingFinalResponse(status: string, result?: string): boolean {
  return status === "completed" && !result?.trim();
}

export type BashGatePolicy = "deny" | "prompt";

/** Configuration for an embedded agent role. */
export interface AgentConfig {
  readonly name: SubagentType;
  readonly displayName?: string;
  readonly description: string;
  readonly builtinToolNames: readonly string[];
  readonly extensions: readonly string[];
  readonly model?: string;
  readonly thinking?: string;
  readonly systemPrompt: string;
  readonly promptMode: "replace" | "append";
  /** Gated bash policy for this subagent. */
  readonly bashGatePolicy?: BashGatePolicy;
}

export interface AgentRecord {
  id: string;
  /** Monotonic retained-session turn generation. The initial prompt is generation 1. */
  generation: number;
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
  /** Messages to resume with after cancelling the current operation. */
  pendingCancelSteers?: string[];
  /** The tool_use_id from the original spawn_agent tool call. */
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
  source: "stop" | "interrupt" | "cancel_and_steer" | "shutdown";
  reason?: string;
}

export interface AgentInvocation {
  /** Full effective provider/model identifier. */
  modelName?: string;
  thinking?: ThinkingLevel;
  isolated?: boolean;
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
  type: SubagentType;
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
