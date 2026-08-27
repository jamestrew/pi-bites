/** Payload-free provider and session observations used by the subagent runner. */

import type { ProviderResponse } from "@earendil-works/pi-ai";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { AgentFailure } from "./types.js";

export interface RunnerDiagnosticCallbacks {
  onDiagnostic?: (event: string, details?: Record<string, unknown>) => void;
  onAssistantFailure?: (failure: AgentFailure) => void;
  signal?: AbortSignal;
}

export interface RequestDiagnosticState {
  requestIndex?: number;
  requestStartedAt?: number;
  resumed?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function arrayLength(value: unknown): number | undefined {
  return Array.isArray(value) ? value.length : undefined;
}

export function errorInfo(error: unknown): { name?: string; message: string } {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { message: String(error) };
}

export function abortReason(signal: AbortSignal | undefined): string | undefined {
  if (!signal?.aborted || signal.reason === undefined) return undefined;
  return signal.reason instanceof Error ? signal.reason.message : String(signal.reason);
}

export function observeAbortSignal(
  signal: AbortSignal | undefined,
  observed: WeakSet<AbortSignal>,
  onAbort: (signal: AbortSignal) => void,
): void {
  if (!signal || observed.has(signal)) return;
  observed.add(signal);
  if (signal.aborted) onAbort(signal);
  else signal.addEventListener("abort", () => onAbort(signal), { once: true });
}

export function emitDiagnostic(
  callback: RunnerDiagnosticCallbacks["onDiagnostic"],
  event: string,
  details?: Record<string, unknown>,
): void {
  try {
    callback?.(event, details);
  } catch {
    // Observability must never change the provider or session lifecycle.
  }
}

function emitAssistantFailure(
  callback: RunnerDiagnosticCallbacks["onAssistantFailure"],
  failure: AgentFailure,
): void {
  try {
    callback?.(failure);
  } catch {
    // Failure reporting must never replace the original failure.
  }
}

/** Summarize a provider payload without persisting prompt or tool content. */
export function summarizeProviderPayload(payload: unknown): Record<string, unknown> {
  let bytes: number | undefined;
  try {
    bytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
  } catch {
    // A provider accepted a non-JSON payload. Keep shape telemetry without content.
  }
  const value = isRecord(payload) ? payload : undefined;
  return {
    ...(bytes === undefined ? {} : { bytes }),
    kind: Array.isArray(payload) ? "array" : payload === null ? "null" : typeof payload,
    ...(value
      ? {
          keys: Object.keys(value).sort(),
          ...(arrayLength(value.messages) === undefined
            ? {}
            : { message_count: arrayLength(value.messages) }),
          ...(arrayLength(value.input) === undefined
            ? {}
            : { input_count: arrayLength(value.input) }),
          ...(arrayLength(value.tools) === undefined
            ? {}
            : { tool_count: arrayLength(value.tools) }),
          has_previous_response_id:
            typeof value.previous_response_id === "string" && value.previous_response_id.length > 0,
        }
      : {}),
  };
}

const DIAGNOSTIC_RESPONSE_HEADERS = new Set([
  "retry-after",
  "retry-after-ms",
  "x-request-id",
  "request-id",
  "openai-request-id",
  "x-ratelimit-limit-requests",
  "x-ratelimit-limit-tokens",
  "x-ratelimit-remaining-requests",
  "x-ratelimit-remaining-tokens",
  "x-ratelimit-reset-requests",
  "x-ratelimit-reset-tokens",
]);

/** Keep request/rate-limit response headers while excluding credentials and cookies. */
export function summarizeProviderResponse(response: ProviderResponse): Record<string, unknown> {
  const headers = Object.fromEntries(
    Object.entries(response.headers).filter(([name]) =>
      DIAGNOSTIC_RESPONSE_HEADERS.has(name.toLowerCase()),
    ),
  );
  return { status: response.status, ...(Object.keys(headers).length > 0 ? { headers } : {}) };
}

/** Record diagnostic-only session events. Functional usage/tool callbacks remain in the runner. */
function recordSessionDiagnosticUnsafe(
  session: AgentSession,
  event: AgentSessionEvent,
  callbacks: RunnerDiagnosticCallbacks,
  state: RequestDiagnosticState = {},
): void {
  const resumed = state.resumed ? { resumed: true } : {};
  if (event.type === "message_end" && event.message.role === "assistant") {
    emitDiagnostic(callbacks.onDiagnostic, "assistant_message_end", {
      request_index: state.requestIndex,
      provider: event.message.provider,
      model: event.message.model,
      stop_reason: event.message.stopReason,
      raw_stop_reason: event.message.rawStopReason,
      error: event.message.errorMessage,
      usage: event.message.usage,
      diagnostics: event.message.diagnostics,
      context: session.getSessionStats().contextUsage,
      manager_signal_aborted: callbacks.signal?.aborted ?? false,
      manager_abort_reason: abortReason(callbacks.signal),
      ...(state.requestStartedAt === undefined
        ? {}
        : { request_elapsed_ms: Date.now() - state.requestStartedAt }),
      ...resumed,
    });
    if (event.message.stopReason === "error" || event.message.stopReason === "aborted") {
      emitAssistantFailure(callbacks.onAssistantFailure, {
        timestamp: event.message.timestamp,
        phase: "assistant",
        message:
          event.message.errorMessage?.trim() ||
          `Assistant response ended with ${event.message.stopReason}`,
        stop_reason: event.message.stopReason,
        provider: event.message.provider,
        model: event.message.model,
        request_index: state.requestIndex,
        manager_signal_aborted: callbacks.signal?.aborted ?? false,
        ...(event.message.diagnostics ? { diagnostics: event.message.diagnostics } : {}),
      });
    }
  } else if (event.type === "auto_retry_start") {
    emitDiagnostic(callbacks.onDiagnostic, "auto_retry_start", {
      attempt: event.attempt,
      max_attempts: event.maxAttempts,
      delay_ms: event.delayMs,
      error: event.errorMessage,
      ...resumed,
    });
  } else if (event.type === "auto_retry_end") {
    emitDiagnostic(callbacks.onDiagnostic, "auto_retry_end", {
      success: event.success,
      attempt: event.attempt,
      final_error: event.finalError,
      ...resumed,
    });
  } else if (event.type === "compaction_start") {
    emitDiagnostic(callbacks.onDiagnostic, "compaction_start", {
      reason: event.reason,
      ...resumed,
    });
  } else if (event.type === "compaction_end") {
    emitDiagnostic(callbacks.onDiagnostic, "compaction_end", {
      reason: event.reason,
      aborted: event.aborted,
      will_retry: event.willRetry,
      error: event.errorMessage,
      tokens_before: event.result?.tokensBefore,
      estimated_tokens_after: event.result?.estimatedTokensAfter,
      ...resumed,
    });
  } else if (event.type === "agent_end") {
    emitDiagnostic(callbacks.onDiagnostic, "agent_end", {
      will_retry: event.willRetry,
      ...resumed,
    });
  } else if (event.type === "agent_settled") {
    emitDiagnostic(callbacks.onDiagnostic, "agent_settled", resumed);
  }
}

export function recordSessionDiagnostic(
  session: AgentSession,
  event: AgentSessionEvent,
  callbacks: RunnerDiagnosticCallbacks,
  state: RequestDiagnosticState = {},
): void {
  try {
    recordSessionDiagnosticUnsafe(session, event, callbacks, state);
  } catch {
    // Diagnostics must not make an otherwise valid session event fail.
  }
}
