import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BashGateApprovalResult } from "./events.js";
import { withApprovalDialog } from "./pending.js";
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
  prompt: string;
  sessionAllowKey: string;
  isAllowed: () => boolean;
  rememberAllowance: () => void;
  review?: () => Promise<{ outcome: "allow" | "deny"; rationale?: string }>;
  checkCurrent?: () => void;
  getConversation?: () => (() => Promise<void>) | undefined;
  failureMessage?: (message: string, phase: "review" | "manual" | "authorization") => string;
}

/** Dependencies must be captured while the owning extension context is active. */
export async function requestCommandApproval(
  options: CommandApprovalOptions,
): Promise<BashGateApprovalResult> {
  const {
    pi,
    ui,
    cwd,
    command,
    toolName,
    signal,
    prompt,
    sessionAllowKey,
    isAllowed,
    rememberAllowance,
  } = options;
  const check = () => {
    options.checkCurrent?.();
    signal.throwIfAborted();
  };
  const failure = (
    error: unknown,
    phase: "review" | "manual" | "authorization",
  ): BashGateApprovalResult => {
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
    if (isAllowed()) return { outcome: "allow-session", authorization: "human-approved" };
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
      if (options.hasUI) {
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
            viewConversation: options.getConversation?.(),
          }),
          signal,
        );
        check();
        if (escalation === "allow") return { outcome: "allow", authorization: "human-approved" };
      }
      return {
        outcome: "deny",
        source: "automode",
        ...(decision.rationale ? { rationale: decision.rationale } : {}),
      };
    }
    if (!options.hasUI) return { outcome: "deny", source: "manual" };
    return await waitForOperation(
      withApprovalDialog(pi.events, signal, async () => {
        check();
        if (isAllowed()) return { outcome: "allow-session", authorization: "human-approved" };
        const gate = { cwd, command, toolName, requiresHuman: true, waitId: randomUUID() } as const;
        const allowSession = `Allow for session ("${sessionAllowKey}")`;
        pi.events.emit("bites:bash_gate", gate);
        try {
          for (;;) {
            const viewConversation = options.getConversation?.();
            const choice = await ui.select(
              prompt,
              ["Allow", allowSession, ...(viewConversation ? ["View conversation"] : []), "Deny"],
              { signal },
            );
            check();
            if (choice === "View conversation" && viewConversation) {
              await viewConversation();
              check();
              continue;
            }
            if (choice === allowSession) {
              rememberAllowance();
              return { outcome: "allow-session", authorization: "human-approved" };
            }
            return choice === "Allow"
              ? { outcome: "allow", authorization: "human-approved" }
              : { outcome: "deny", source: "manual" };
          }
        } catch (error) {
          return failure(error, "manual");
        } finally {
          pi.events.emit("bites:bash_gate_resolved", gate);
        }
      }),
      signal,
    );
  } catch (error) {
    return failure(error, "authorization");
  }
}
