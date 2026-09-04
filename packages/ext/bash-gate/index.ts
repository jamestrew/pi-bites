import { waitForAuthorization, withApprovalDialog } from "./pending.js";
import type { ShellAuthorizationDecision } from "./authorization.js";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BashGateRule, BitesConfig } from "../config.js";
import { requestSubagentApproval } from "./events.js";
import { promptAutoModeEscalation } from "./automode-escalation.js";
import type { AutoModeController } from "../automode/index.js";
import { ShellAuthorizationTransactions } from "./authorization.js";
import {
  findMatchedPatterns,
  resolveEffectiveRules,
  subagentMetadata,
  subagentBashGatePolicy,
} from "./policy.js";
export {
  findMatchedPattern,
  findMatchedPatterns,
  DEFAULT_BASH_GATE_RULES,
  subagentBashGatePolicy,
} from "./policy.js";
export type { BashGateMatch } from "./policy.js";
export type { ApprovalRequest } from "./events.js";

export interface CommandAuthorizationRequest {
  toolCallId: string;
  toolName: "bash" | "exec_command";
  command: string;
  signal?: AbortSignal;
}

/** Capture while ctx is active. The callback must launch synchronously; never defer it.
 * Callers validate arguments first and give every nested launch its own toolCallId.
 * Denial rejects only this launch. Runtime/cell cancellation remains the caller's job.
 */
export interface CommandAuthorizationSession {
  authorize<T>(request: CommandAuthorizationRequest, launch: () => T): Promise<T>;
}

export interface BashGateController {
  isYolo(): boolean;
  captureSession(ctx: ExtensionContext): CommandAuthorizationSession;
}

function commandPolicyRequest(
  toolName: string,
  input: Record<string, unknown>,
): { command: string; toolName: CommandAuthorizationRequest["toolName"] } | undefined {
  if (toolName === "bash" && typeof input.command === "string") {
    return { command: input.command, toolName };
  }
  if (toolName === "exec_command" && typeof input.cmd === "string") {
    return { command: input.cmd, toolName };
  }
  return undefined;
}

/**
 * When a command is approved, add the time spent waiting in the gate to the
 * timeout (if one was set by the model). This is necessary because the TUI
 * elapsed timer starts at `tool_execution_start` — which fires *before* our
 * gate handler runs — so the timer is already counting while the user reads
 * the prompt. The actual process `setTimeout` inside `ops.exec()` only starts
 * after `spawn()`, which is after this handler returns, so the spawned process
 * always gets its full intended timeout. By compensating `event.input.timeout`
 * here we keep the displayed elapsed time consistent with the timeout value.
 */
function compensateTimeout(input: Record<string, unknown>, gateStartMs: number): void {
  if (typeof input.timeout !== "number") return;
  const gateWaitSec = (Date.now() - gateStartMs) / 1000;
  input.timeout = input.timeout + gateWaitSec;
}

export default function registerBashGate(
  pi: ExtensionAPI,
  configRef: { current: BitesConfig },
  autoMode?: AutoModeController,
): BashGateController {
  pi.registerFlag("yolo", {
    description: "Bypass all bash-gate confirmations (useful for non-interactive / scripted runs)",
    type: "boolean",
    default: false,
  });

  let rules: BashGateRule[] = [];
  let mainAgentYolo = false;
  let owner = new AbortController();
  const usedCallIds = new Set<string>();
  const authorizations = new ShellAuthorizationTransactions(pi);
  const sessionAllowed = new Set<string>();
  const finishedSubagents = new Set<string>();
  const activeSubagentGenerations = new Map<string, number>();

  function syncYoloStatus(ctx: ExtensionContext): void {
    ctx.ui.setStatus("bash-gate-yolo", pi.getFlag("yolo") || mainAgentYolo ? "🔥 YOLO" : undefined);
  }

  pi.on("session_start", (_event, ctx) => {
    endSession();
    owner = new AbortController();
    usedCallIds.clear();
    authorizations.sessionStarted();
    rules = resolveEffectiveRules(configRef.current);
    mainAgentYolo = configRef.current.bashGate?.mode === "yolo";
    if (pi.getFlag("yolo") || mainAgentYolo) autoMode?.setEnabled(false, ctx);
    sessionAllowed.clear();
    finishedSubagents.clear();
    activeSubagentGenerations.clear();
    syncYoloStatus(ctx);
  });
  function endSession(): void {
    authorizations.sessionEnded();
    owner.abort(new Error("Bash gate: owning session changed before authorization completed."));
  }
  pi.on("session_shutdown", endSession);
  // Flush while the source branch is still active. A later hook or a cancelled
  // summary can stop navigation, so renew ownership here rather than waiting for
  // session_tree. Session allowances retain their original live-session lifetime.
  pi.on("session_before_tree", () => {
    endSession();
    owner = new AbortController();
    authorizations.sessionStarted();
  });

  pi.registerShortcut("alt+y", {
    description: "Cycle bash-gate mode: YOLO, Auto, Bash gate",
    handler: async (ctx) => {
      if (pi.getFlag("yolo")) {
        ctx.ui.notify("Bash gate mode is fixed to YOLO by --yolo.", "info");
        return;
      }

      if (mainAgentYolo) {
        mainAgentYolo = false;
        autoMode?.setEnabled(true, ctx);
      } else if (autoMode?.isEnabled()) {
        autoMode.setEnabled(false, ctx);
      } else {
        mainAgentYolo = true;
      }
      syncYoloStatus(ctx);
      const mode = mainAgentYolo ? "YOLO" : autoMode?.isEnabled() ? "Auto" : "Bash gate";
      ctx.ui.notify(`${mode} mode enabled.`, "info");
    },
  });

  function clearSubagentAllowances(eventData: { id: string; generation?: number }): void {
    const agentId = eventData.id;
    const activeGeneration = activeSubagentGenerations.get(agentId);
    if (
      eventData.generation !== undefined &&
      activeGeneration !== undefined &&
      activeGeneration !== eventData.generation
    )
      return;
    finishedSubagents.add(agentId);
    const prefix = `subagent:${agentId}:`;
    for (const key of sessionAllowed) {
      if (key.startsWith(prefix)) sessionAllowed.delete(key);
    }
  }

  pi.events.on("subagents:started", (data) => {
    const event = data as { id: string; generation: number };
    if ((activeSubagentGenerations.get(event.id) ?? 0) > event.generation) return;
    activeSubagentGenerations.set(event.id, event.generation);
    finishedSubagents.delete(event.id);
  });
  pi.events.on("subagents:completed", (data) =>
    clearSubagentAllowances(data as { id: string; generation?: number }),
  );
  pi.events.on("subagents:failed", (data) =>
    clearSubagentAllowances(data as { id: string; generation?: number }),
  );

  function captureSession(ctx: ExtensionContext): CommandAuthorizationSession {
    const ownerSignal = owner.signal;
    const contextSignal = ctx.signal;
    const cwd = ctx.cwd;
    const hasUI = ctx.hasUI;
    const ui = ctx.ui;
    const sessionManager = ctx.sessionManager;
    const entries = [...sessionManager.getEntries()];
    const reviewCtx = {
      modelRegistry: ctx.modelRegistry,
      model: ctx.model,
      signal: ctx.signal,
      sessionManager,
    };
    return {
      async authorize(request, launch) {
        const { command, toolName, toolCallId } = request;
        ownerSignal.throwIfAborted();
        if (!toolCallId || usedCallIds.has(toolCallId))
          throw new Error("Bash gate: command requires a unique toolCallId.");
        usedCallIds.add(toolCallId);
        const signal = AbortSignal.any([
          ownerSignal,
          ...[contextSignal, request.signal].filter(
            (value): value is AbortSignal => value !== undefined,
          ),
        ]);
        const wait = <T>(promise: Promise<T>) => waitForAuthorization(promise, signal);
        const authorization = authorizations.begin({ version: 1, command, toolName, toolCallId });
        async function decide(): Promise<ShellAuthorizationDecision> {
          signal.throwIfAborted();
          const matchedPatterns = await wait(findMatchedPatterns(command, rules));
          signal.throwIfAborted();
          if (matchedPatterns.length === 0)
            return { outcome: "allow", authorization: "not-reviewed" };

          const matchedPatternLabels = matchedPatterns.map((match) => match.label);
          const sessionAllowKey = matchedPatternLabels.join(" && ");
          const metadata = subagentMetadata(entries);
          const subagentPolicy = subagentBashGatePolicy(entries);
          const effectiveSessionAllowKey = metadata?.agentId
            ? `subagent:${metadata.agentId}:${sessionAllowKey}`
            : sessionAllowKey;

          // --yolo bypasses every gate; shortcut YOLO reaches default subagents via the parent broker.
          if (pi.getFlag("yolo") || (mainAgentYolo && metadata === undefined))
            return { outcome: "allow", authorization: "not-reviewed" };

          // Pattern was already approved for this session — run silently.
          if (sessionAllowed.has(effectiveSessionAllowKey))
            return { outcome: "allow", authorization: "human-approved" };
          if (subagentPolicy === "deny") {
            return {
              outcome: "block",
              reason: "Bash gate: gated command not allowed for this subagent.",
            };
          }

          if (subagentPolicy === "prompt") {
            if (!metadata?.agentId || finishedSubagents.has(metadata.agentId)) {
              return {
                outcome: "block",
                reason: "Bash gate: subagent identity is unavailable or finished.",
              };
            }

            const subagentGate = { cwd, command, toolName, requiresHuman: false } as const;
            pi.events.emit("bites:bash_gate", subagentGate);
            try {
              const reasons = matchedPatterns.flatMap((match) =>
                match.reason === undefined ? [] : [match.reason],
              );
              const result = await wait(
                requestSubagentApproval(
                  pi,
                  {
                    toolCallId,
                    agentId: metadata.agentId,
                    title: metadata.title,
                    command,
                    toolName,
                    labels: matchedPatternLabels,
                    reasons,
                    sessionAllowKey,
                  },
                  signal,
                ),
              );

              signal.throwIfAborted();
              if (finishedSubagents.has(metadata.agentId)) {
                return {
                  outcome: "block",
                  reason: "Bash gate: subagent finished before approval.",
                };
              }

              if (result.outcome === "allow-session") {
                sessionAllowed.add(effectiveSessionAllowKey);
                return {
                  outcome: "allow",
                  authorization: result.authorization,
                };
              }

              if (result.outcome === "allow") {
                return {
                  outcome: "allow",
                  authorization: result.authorization,
                };
              }

              if (result.outcome === "failure") {
                return {
                  outcome: "block",
                  reason: `Bash gate: parent approval failed closed: ${result.message}`,
                };
              }

              if (result.source === "automode") {
                return {
                  outcome: "block",
                  reason: `Automode denied this command${result.rationale ? `: ${result.rationale}` : "."} Do not pursue the same outcome through a workaround or indirect execution; use a materially safer alternative or ask the user.`,
                };
              }

              return {
                outcome: "block",
                reason: "Bash gate: command was denied by parent approval.",
              };
            } finally {
              pi.events.emit("bites:bash_gate_resolved", subagentGate);
            }
          }

          if (autoMode?.isEnabled()) {
            const autoGate = { cwd, command, toolName, requiresHuman: false } as const;
            pi.events.emit("bites:bash_gate", autoGate);
            try {
              let decision;
              try {
                decision = await wait(
                  autoMode.review(
                    {
                      command,
                      toolName,
                      toolCallId,
                      labels: matchedPatternLabels,
                      reasons: matchedPatterns.flatMap((match) =>
                        match.reason === undefined ? [] : [match.reason],
                      ),
                    },
                    { ...reviewCtx, signal },
                  ),
                );
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                return {
                  outcome: "block",
                  reason: `Automode review failed closed: ${message}`,
                };
              }

              if (decision.outcome === "allow") {
                return {
                  outcome: "allow",
                  authorization: "reviewer-approved",
                };
              }

              const deniedReason = `Automode denied this command${decision.rationale ? `: ${decision.rationale}` : "."} Do not pursue the same outcome through a workaround; use a materially safer alternative or ask the user.`;
              if (!hasUI) return { outcome: "block", reason: deniedReason };

              const escalation = await wait(
                promptAutoModeEscalation({
                  pi,
                  ui,
                  cwd,
                  command,
                  toolName,
                  rationale: decision.rationale,
                  signal,
                  isAllowed: () => sessionAllowed.has(effectiveSessionAllowKey),
                }),
              );
              if (escalation === "allow") {
                return {
                  outcome: "allow",
                  authorization: "human-approved",
                };
              }
              return { outcome: "block", reason: deniedReason };
            } finally {
              pi.events.emit("bites:bash_gate_resolved", autoGate);
            }
          }

          if (!hasUI) {
            // Non-interactive mode (e.g. `pi -p`) — block by default.
            return {
              outcome: "block",
              reason: "Bash gate: no UI available for confirmation.",
            };
          }

          return await wait(
            withApprovalDialog(pi.events, signal, async (): Promise<ShellAuthorizationDecision> => {
              if (sessionAllowed.has(effectiveSessionAllowKey))
                return { outcome: "allow", authorization: "human-approved" };
              const manualGate = {
                cwd,
                command,
                toolName,
                requiresHuman: true,
                waitId: randomUUID(),
              } as const;

              pi.events.emit("bites:bash_gate", manualGate);

              const reasons = matchedPatterns.map((match) => match.reason).filter(Boolean);
              const prompt =
                reasons.length > 0
                  ? `🔒 Bash gate — ${reasons.join("; ")} (${matchedPatternLabels.join(", ")})`
                  : `🔒 Bash gate — command requires approval (${matchedPatternLabels.join(", ")})`;
              try {
                const choice = await ui.select(
                  prompt,
                  ["Allow", `Allow for session ("${sessionAllowKey}")`, "Deny"],
                  { signal },
                );

                signal.throwIfAborted();
                if (choice?.startsWith("Allow for session")) {
                  sessionAllowed.add(sessionAllowKey);
                  return {
                    outcome: "allow",
                    authorization: "human-approved",
                  };
                }

                if (choice === "Allow") {
                  return {
                    outcome: "allow",
                    authorization: "human-approved",
                  };
                }

                return {
                  outcome: "block",
                  reason: "Bash gate: command was denied by the user.",
                };
              } catch (error) {
                return {
                  outcome: "block",
                  reason: `Bash gate: approval failed closed: ${error instanceof Error ? error.message : String(error)}`,
                };
              } finally {
                pi.events.emit("bites:bash_gate_resolved", manualGate);
              }
            }),
          );
        }
        let decision: ShellAuthorizationDecision;
        try {
          decision = await decide();
          signal.throwIfAborted();
        } catch (error) {
          decision = {
            outcome: "block",
            reason: signal.aborted
              ? ownerSignal.aborted
                ? "Bash gate: owning session changed before authorization completed."
                : "Bash gate: command authorization cancelled."
              : `Bash gate: authorization failed closed: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
        const blocked = authorization.complete(decision);
        if (blocked) throw new Error(blocked.reason);
        signal.throwIfAborted();
        return await launch();
      },
    };
  }

  pi.on("tool_call", async (event, ctx) => {
    const command = commandPolicyRequest(event.toolName, event.input);
    if (!command) return undefined;
    const gateStartMs = Date.now();
    try {
      await captureSession(ctx).authorize(
        { ...command, toolCallId: event.toolCallId || randomUUID() },
        () => undefined,
      );
      compensateTimeout(event.input, gateStartMs);
      return undefined;
    } catch (error) {
      return { block: true, reason: error instanceof Error ? error.message : String(error) };
    }
  });

  return { isYolo: () => pi.getFlag("yolo") === true || mainAgentYolo, captureSession };
}
