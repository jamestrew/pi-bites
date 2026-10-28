import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BashGateApprovalResult } from "./events.js";
import { waitForOperation } from "../shared/abortable-wait.js";
import { promptAutoModeEscalation } from "./automode-escalation.js";

interface CommandApprovalOptions {
  pi: Pick<ExtensionAPI, "events">;
  ui: Pick<ExtensionContext["ui"], "select" | "notify">;
  hasUI: boolean;
  cwd: string;
  command: string;
  toolName?: "bash" | "exec_command";
  signal: AbortSignal;
  mode: "auto" | "strict";
  sessionAllowKey: string;
  isAllowed: () => boolean;
  rememberAllowance: () => void;
  review?: () => Promise<{ outcome: "allow" | "deny"; rationale?: string }>;
  checkCurrent?: () => void;
  failureMessage?: (message: string, phase: "review" | "authorization") => string;
}

/** Dependencies must be captured while the owning extension context is active. */
export async function requestCommandApproval(
  options: CommandApprovalOptions,
): Promise<BashGateApprovalResult> {
  const { pi, ui, cwd, command, toolName, signal, isAllowed } = options;
  const check = () => {
    options.checkCurrent?.();
    signal.throwIfAborted();
  };
  const failure = (error: unknown, phase: "review" | "authorization"): BashGateApprovalResult => {
    const message = error instanceof Error ? error.message : String(error);
    return {
      outcome: "failure",
      message:
        options.failureMessage?.(message, phase) ??
        (phase === "review" ? `Automode reviewer failed: ${message}` : message),
    };
  };
  try {
    check();
    if (options.mode === "auto" && isAllowed())
      return { outcome: "allow-session", authorization: "human-approved" };
    if (options.review) {
      let decision;
      try {
        decision = await waitForOperation(options.review(), signal);
      } catch (error) {
        check();
        return failure(error, "review");
      }
      check();
      if (decision.outcome === "allow")
        return { outcome: "allow", authorization: "reviewer-approved" };
      if (options.mode === "auto" && options.hasUI) {
        const escalation = await waitForOperation(
          promptAutoModeEscalation({
            pi,
            ui,
            cwd,
            command,
            toolName,
            signal,
            isAllowed,
            rationale: decision.rationale,
            checkCurrent: check,
            sessionAllowKey: options.sessionAllowKey,
            rememberAllowance: options.rememberAllowance,
          }),
          signal,
        );
        check();
        if (isAllowed()) return { outcome: "allow-session", authorization: "human-approved" };
        if (escalation === "allow-session")
          return { outcome: "allow-session", authorization: "human-approved" };
        if (escalation === "allow") return { outcome: "allow", authorization: "human-approved" };
      }
      return {
        outcome: "deny",
        source: "automode",
        ...(decision.rationale ? { rationale: decision.rationale } : {}),
      };
    }
    return {
      outcome: "failure",
      message: "Bash gate: automated reviewer is disabled or unavailable.",
    };
  } catch (error) {
    return failure(error, "authorization");
  }
}
