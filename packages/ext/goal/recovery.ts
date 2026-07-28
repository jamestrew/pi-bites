import { isContextOverflow } from "@earendil-works/pi-ai/compat";

import { assistantMessageForOverflowCheck } from "./recovery-adapters.js";

/** Host AgentSession performs one overflow compact-and-retry before giving up. */
export const MAX_CONTEXT_COMPACTION_RETRIES = 1;

export interface AssistantErrorMessage {
  role: string;
  stopReason?: string;
  errorMessage?: string;
  usage?: {
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
}

export type TerminalAssistantErrorMessage = AssistantErrorMessage & {
  role: "assistant";
  stopReason: "error";
};

export function isErrorAssistantMessage<T extends AssistantErrorMessage>(
  message: T,
): message is T & TerminalAssistantErrorMessage {
  return message.role === "assistant" && message.stopReason === "error";
}

export function isSuccessfulAssistantTurn(message: AssistantErrorMessage): boolean {
  return (
    message.role === "assistant" &&
    message.stopReason !== "error" &&
    message.stopReason !== "aborted"
  );
}

export function isAssistantContextOverflow(
  message: AssistantErrorMessage,
  contextWindow: number,
): boolean {
  if (message.role !== "assistant") {
    return false;
  }
  if (contextWindow <= 0) {
    return isContextOverflowError(message.errorMessage);
  }
  return isContextOverflow(assistantMessageForOverflowCheck(message), contextWindow);
}

export function isContextOverflowError(errorMessage: string | undefined): boolean {
  return isContextOverflow(
    assistantMessageForOverflowCheck({
      stopReason: "error",
      errorMessage: errorMessage ?? "",
    }),
  );
}

export function isProviderLimitError(errorMessage: string | undefined): boolean {
  return /GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|usage limit has been reached|available balance|insufficient_quota|out of budget|quota exceeded|billing/i.test(
    errorMessage ?? "",
  );
}

export function terminalFailureStatus(
  message: TerminalAssistantErrorMessage,
): "blocked" | "usageLimited" {
  return isProviderLimitError(message.errorMessage) ? "usageLimited" : "blocked";
}

export function overflowRecoveryPendingMessage(): string {
  return "Goal recovery pending (recovering from context overflow); wait for host retry/compaction or send a new user message if it does not recover.";
}
