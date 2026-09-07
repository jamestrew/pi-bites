/**
 * pi-agents — A pi extension providing Claude Code-style autonomous sub-agents.
 *
 * Tools:
 *   spawn_agent   — LLM-callable: spawn a sub-agent
 *   WaitAgent     — LLM-callable: wait for selected sub-agents
 *   send_input    — LLM-callable: send input to a running sub-agent
 *
 * Commands:
 *   /agents                 — Interactive agent management menu
 */

import { randomUUID } from "node:crypto";
import {
  type ExtensionAPI,
  type ExtensionContext,
  type SessionManager,
} from "@earendil-works/pi-coding-agent";
import { createAgentCompletionHandler } from "./agent-completion.js";
import { AgentManager } from "./agent-manager.js";
import { registerRpcHandlers } from "./cross-extension-rpc.js";
import { registerNotificationRenderer } from "./notifications.js";
import { registerAgentsCommand } from "./agents-command.js";
import { getModelLabelFromConfig } from "./model-resolver.js";
import { registerSubagentMessageRenderer } from "./subagent-message-renderer.js";
import { createSubagentMessenger } from "./subagent-messages.js";
import { registerAgentTool } from "./register-agent-tool.js";
import { registerSendInput } from "./register-send-input.js";
import { registerWaitAgent } from "./register-wait-agent.js";
import { type AgentActivity } from "./ui/agent-format.js";
import { FleetList } from "./ui/fleet-list.js";
import { CONVERSATION_OVERLAY_OPTIONS, ConversationViewer } from "./ui/conversation-viewer.js";
import {
  onSubagentApprovalRequest,
  type BashGateApprovalResult,
  type BitesBashGatePayload,
} from "../bash-gate/events.js";
import type { BashGateController } from "../bash-gate/index.js";
import { promptAutoModeEscalation } from "../bash-gate/automode-escalation.js";
import {
  buildSubagentReviewerTranscript,
  type AutoModeController,
  type ReviewerMessage,
} from "../automode/index.js";

// ---- Shared helpers ----

export default function (
  pi: ExtensionAPI,
  autoMode?: Pick<AutoModeController, "isEnabled" | "review">,
  bashGate?: BashGateController,
  getAutoCompactionThreshold?: () => number | undefined,
) {
  // ---- Register custom notification renderers ----
  registerNotificationRenderer(pi);
  registerSubagentMessageRenderer(pi);
  const parentMessenger = createSubagentMessenger(pi);

  // ---- Agent activity tracking ----
  const agentActivity = new Map<string, AgentActivity>();

  let manager: AgentManager;
  let fleet: FleetList;
  const completion = createAgentCompletionHandler({
    pi,
    getRecord: (id) => manager.getRecord(id),
    onAgentFinishedUI: (id) => {
      agentActivity.delete(id);
      fleet.onAgentFinished(id);
    },
    onAgentResultPendingUI: (id) => fleet.onAgentResultPending(id),
    scheduleAutomatic: (parentSessionId, deliver, cancel) =>
      parentMessenger.scheduleFinal(parentSessionId, deliver, cancel),
  });

  manager = new AgentManager(
    completion.onAgentComplete,
    undefined,
    (record) => {
      // Emit started event when agent transitions to running (including from queue)
      pi.events.emit("subagents:started", {
        id: record.id,
        generation: record.generation,
        type: record.type,
        description: record.description,
      });
    },
    (record, info) => {
      // Emit compacted event when agent's session compacts (preserves count on record).
      pi.events.emit("subagents:compacted", {
        id: record.id,
        type: record.type,
        description: record.description,
        reason: info.reason,
        tokensBefore: info.tokensBefore,
        compactionCount: record.compactionCount,
      });
    },
    (parentSessionId, sender, message) =>
      completion.onAgentMessage(sender, message) ||
      parentMessenger.send(parentSessionId, sender, message),
    getAutoCompactionThreshold,
  );

  // Expose manager via Symbol.for() global registry for cross-package access.
  // Standard Node.js pattern for cross-package singletons (used by OpenTelemetry, etc.).
  const MANAGER_KEY = Symbol.for("pi-subagents:manager");
  Reflect.set(globalThis, MANAGER_KEY, {
    waitForAll: () => manager.waitForAll(),
    hasRunning: () => manager.hasRunning(),
    spawn: (
      piRef: ExtensionAPI,
      ctx: ExtensionContext,
      type: string,
      prompt: string,
      options: Parameters<AgentManager["spawn"]>[4],
    ) => manager.spawn(piRef, ctx, type, prompt, options),
    getRecord: (id: string) => manager.getRecord(id),
  });

  // --- Cross-extension RPC via pi.events ---
  let currentCtx: ExtensionContext | undefined;
  let currentSessionToken: object | undefined;

  // Capture ctx from session_start for the RPC spawn handler.
  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;
    currentSessionToken = {};
    // The runtime supplies the concrete manager, but ExtensionContext exposes only its read facade.
    // Snapshot this documented append operation now so shutdown never touches a stale ctx.
    const sessionManager = ctx.sessionManager as typeof ctx.sessionManager &
      Pick<SessionManager, "appendCustomMessageEntry">;
    parentMessenger.sessionStarted(
      sessionManager.getSessionId(),
      (customType, content, display, details) =>
        sessionManager.appendCustomMessageEntry(customType, content, display, details),
    );
    manager.clearCompleted();
  });

  pi.on("agent_start", () => parentMessenger.agentStarted());
  pi.on("turn_start", () => parentMessenger.turnStarted());
  pi.on("message_end", (event) => {
    if (event.message.role === "assistant") {
      parentMessenger.assistantMessageEnded(
        !event.message.content.some((part) => part.type === "toolCall"),
        event.message.stopReason === "aborted",
      );
    }
  });
  pi.on("turn_end", () => parentMessenger.turnEnded());
  pi.on("agent_settled", (_event, ctx) => {
    if (ctx.isIdle()) parentMessenger.agentSettled();
  });

  pi.on("session_before_switch", () => {
    currentCtx = undefined;
    currentSessionToken = undefined;
  });

  const unsubBashGateApproval = onSubagentApprovalRequest(pi, async (request) => {
    if (bashGate?.isYolo()) return { outcome: "allow", authorization: "not-reviewed" };

    const ctx = currentCtx;
    if (!ctx) return { outcome: "failure", message: "parent approval context unavailable" };
    const ownerSessionToken = currentSessionToken;
    const sessionChanged = (): BashGateApprovalResult | undefined =>
      ownerSessionToken && ownerSessionToken === currentSessionToken
        ? undefined
        : { outcome: "failure", message: "parent approval session changed" };
    const ui = ctx.ui;
    const hasUI = ctx.hasUI;
    const cwd = ctx.cwd;

    try {
      if (autoMode?.isEnabled()) {
        const record = request.agentId ? manager.getRecord(request.agentId) : undefined;
        const session = record?.session;
        let decision;
        try {
          decision = await autoMode.review(
            {
              command: request.command,
              toolName: request.toolName,
              labels: request.labels,
              reasons: request.reasons,
              subagentContext: session
                ? buildSubagentReviewerTranscript(
                    session.messages as ReviewerMessage[],
                    session.sessionManager.getBranch(),
                  )
                : "<subagent context unavailable>",
            },
            ctx,
          );
        } catch (error) {
          return {
            outcome: "failure",
            message: `Automode reviewer failed: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
        const changedAfterReview = sessionChanged();
        if (changedAfterReview) return changedAfterReview;

        if (decision.outcome === "allow")
          return { outcome: "allow", authorization: "reviewer-approved" };
        if (!hasUI) {
          return {
            outcome: "deny",
            source: "automode",
            ...(decision.rationale ? { rationale: decision.rationale } : {}),
          };
        }

        const escalation = await promptAutoModeEscalation({
          pi,
          ui,
          cwd,
          command: request.command,
          toolName: request.toolName,
          ...(decision.rationale ? { rationale: decision.rationale } : {}),
          ...(record?.session
            ? {
                viewConversation: async () => {
                  const activeSession = record.session;
                  if (!activeSession) return;
                  await ui.custom<undefined>(
                    (tui, theme, keybindings, done) =>
                      new ConversationViewer(
                        tui,
                        activeSession,
                        record,
                        agentActivity.get(record.id),
                        theme,
                        done,
                        undefined,
                        keybindings,
                      ),
                    CONVERSATION_OVERLAY_OPTIONS,
                  );
                },
              }
            : {}),
        });
        const changedAfterEscalation = sessionChanged();
        if (changedAfterEscalation) return changedAfterEscalation;
        return escalation === "allow"
          ? { outcome: "allow", authorization: "human-approved" }
          : {
              outcome: "deny",
              source: "automode",
              ...(decision.rationale ? { rationale: decision.rationale } : {}),
            };
      }

      if (!hasUI) return { outcome: "deny", source: "manual" };
      const labels = request.labels.join(", ") || "unknown rule";
      const reasons = request.reasons.filter(Boolean).join("; ");
      const prompt = reasons
        ? `🔒 ${request.title} requests bash approval: ${request.command}\n${reasons} (${labels})`
        : `🔒 ${request.title} requests bash approval: ${request.command}\n${labels}`;
      const allowSession = `Allow for session ("${request.sessionAllowKey}")`;
      const manualGate = {
        cwd,
        command: request.command,
        toolName: request.toolName,
        requiresHuman: true,
        waitId: randomUUID(),
      } as const;
      pi.events.emit("bites:bash_gate", manualGate);
      try {
        for (;;) {
          const record = request.agentId ? manager.getRecord(request.agentId) : undefined;
          const viewConversation = record?.session ? "View conversation" : undefined;
          const choice = await ui.select(prompt, [
            "Allow",
            allowSession,
            ...(viewConversation ? [viewConversation] : []),
            "Deny",
          ]);
          const changedAfterPrompt = sessionChanged();
          if (changedAfterPrompt) return changedAfterPrompt;

          if (choice === viewConversation && record?.session) {
            const session = record.session;
            await ui.custom<undefined>(
              (tui, theme, keybindings, done) =>
                new ConversationViewer(
                  tui,
                  session,
                  record,
                  agentActivity.get(record.id),
                  theme,
                  done,
                  undefined,
                  keybindings,
                ),
              CONVERSATION_OVERLAY_OPTIONS,
            );
            const changedAfterConversation = sessionChanged();
            if (changedAfterConversation) return changedAfterConversation;
            continue;
          }

          return choice === allowSession
            ? { outcome: "allow-session", authorization: "human-approved" }
            : choice === "Allow"
              ? { outcome: "allow", authorization: "human-approved" }
              : { outcome: "deny", source: "manual" };
        }
      } finally {
        pi.events.emit("bites:bash_gate_resolved", manualGate);
      }
    } catch (error) {
      return {
        outcome: "failure",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  });

  const {
    unsubPing: unsubPingRpc,
    unsubSpawn: unsubSpawnRpc,
    unsubStop: unsubStopRpc,
  } = registerRpcHandlers({
    events: pi.events,
    pi,
    getCtx: () => currentCtx,
    manager,
  });

  // Broadcast readiness so extensions loaded after us can discover us
  pi.events.emit("subagents:ready", {});

  // Claude Code-style FleetView: navigable list of main + subagents above the editor.
  fleet = new FleetList(manager, agentActivity);
  const humanGate = (data: unknown) => {
    const gate = data as BitesBashGatePayload;
    return gate.requiresHuman ? gate : undefined;
  };
  const unsubBashGateStarted = pi.events.on("bites:bash_gate", (data) => {
    const gate = humanGate(data);
    if (gate) fleet.bashGateStarted(gate.waitId);
  });
  const unsubBashGateResolved = pi.events.on("bites:bash_gate_resolved", (data) => {
    const gate = humanGate(data);
    if (gate) fleet.bashGateResolved(gate.waitId);
  });

  // Persist queued parent deliveries before aborting children and tearing down.
  pi.on("session_shutdown", async () => {
    currentCtx = undefined;
    currentSessionToken = undefined;
    unsubSpawnRpc();
    unsubStopRpc();
    unsubPingRpc();
    unsubBashGateApproval();
    unsubBashGateStarted();
    unsubBashGateResolved();
    Reflect.deleteProperty(globalThis, MANAGER_KEY);
    parentMessenger.flushForShutdown();
    manager.abortAll();
    parentMessenger.dispose();
    completion.dispose();
    fleet.dispose();
    await manager.shutdown();
  });
  let fleetViewEnabled = true;
  function isFleetViewEnabled(): boolean {
    return fleetViewEnabled;
  }
  function setFleetViewEnabled(b: boolean): void {
    fleetViewEnabled = b;
    fleet.setEnabled(b);
  }

  // ---- Scope models configuration ----
  let scopeModelsEnabled = false;
  function isScopeModelsEnabled(): boolean {
    return scopeModelsEnabled;
  }
  function setScopeModelsEnabled(enabled: boolean): void {
    scopeModelsEnabled = enabled;
  }

  // Grab UI context from first tool execution.
  pi.on("tool_execution_start", async (_event, ctx) => {
    fleet.setUICtx(ctx.ui);
  });

  // ---- spawn_agent tool ----
  registerAgentTool(pi, {
    manager,
    agentActivity,
    fleet,
    isScopeModelsEnabled,
    setScopeModelsEnabled,
    setFleetViewEnabled,
  });

  // ---- WaitAgent and send_input tools ----
  registerWaitAgent(pi, {
    waitFor: completion.waitFor,
    getRecord: (id) => manager.getRecord(id),
  });
  registerSendInput(pi, manager);

  // ---- /agents interactive menu ----
  registerAgentsCommand(pi, {
    manager,
    agentActivity,
    getModelLabelFromConfig,
    isScopeModelsEnabled,
    setScopeModelsEnabled,
    isFleetViewEnabled,
    setFleetViewEnabled,
  });
}
