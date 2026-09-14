import { applyAndEmitLoaded } from "./settings.js";
import type { AgentRecord } from "./types.js";
import { SubagentController } from "./operations.js";
/**
 * pi-agents — A pi extension providing Claude Code-style autonomous sub-agents.
 *
 * Tools:
 *   spawn_agent   — LLM-callable: spawn a sub-agent
 *   wait_agent    — LLM-callable: wait for selected sub-agents
 *   send_input    — LLM-callable: send input to a running sub-agent
 *   close_agent   — LLM-callable: close a retained sub-agent
 *
 * Commands:
 *   /agents                 — Interactive agent management menu
 */

import { withApprovalDialog, waitForAuthorization } from "../bash-gate/pending.js";
import { randomUUID } from "node:crypto";
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createAgentCompletionHandler } from "./agent-completion.js";
import { AgentManager } from "./agent-manager.js";
import { registerRpcHandlers } from "./cross-extension-rpc.js";
import { registerNotificationRenderer } from "./notifications.js";
import { registerAgentsCommand } from "./agents-command.js";
import { getModelLabelFromConfig } from "./model-resolver.js";
import { registerSubagentMessageRenderer } from "./subagent-message-renderer.js";
import { createSubagentMessenger, bindSubagentMessenger } from "./subagent-messages.js";
import { createAgentTool } from "./register-agent-tool.js";
import { createResumeAgent } from "./register-resume-agent.js";
import { createCloseAgent } from "./register-close-agent.js";
import { createSendInput } from "./register-send-input.js";
import { createWaitAgent } from "./register-wait-agent.js";
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

export function createSubagents(
  pi: ExtensionAPI,
  autoMode?: Pick<AutoModeController, "isEnabled" | "review">,
  bashGate?: Pick<BashGateController, "isYolo">,
  getAutoCompactionThreshold?: () => number | undefined,
  getAllowedTools: () => string[] = () => pi.getActiveTools(),
) {
  // ---- Register custom notification renderers ----
  registerNotificationRenderer(pi);
  registerSubagentMessageRenderer(pi);
  const parentMessenger = createSubagentMessenger(pi);
  const deliveries = new Map<
    string,
    { pi: ExtensionAPI; messenger: ReturnType<typeof createSubagentMessenger> }
  >();
  const childControllers = new Map<string, SubagentController>();
  const startParentMessenger = bindSubagentMessenger(pi, parentMessenger, (id) => {
    deliveries.clear();
    deliveries.set(id, { pi, messenger: parentMessenger });
  });

  // ---- Agent activity tracking ----
  const agentActivity = new Map<string, AgentActivity>();
  // Session approvals are scoped to a live child conversation, never its retained id.
  const parentAllowances = new Map<string, { incarnation?: string; keys: Set<string> }>();

  let manager: AgentManager;
  let fleet: FleetList;
  let operations: SubagentController;
  let currentSessionToken: object | undefined;
  const retiredConversations = new WeakSet<AgentRecord>();
  const completion = createAgentCompletionHandler({
    pi,
    getRecord: (id) => manager.getRecord(id),
    onAgentFinishedUI: (id) => {
      agentActivity.delete(id);
      fleet.onAgentFinished(id);
    },
    onAgentResultPendingUI: (id) => fleet.onAgentResultPending(id),
    shouldNotify: (record) => !retiredConversations.has(record),
    deliveryPi: (id) => deliveries.get(id)?.pi,
    scheduleAutomatic: (parentSessionId, deliver, cancel) =>
      deliveries.get(parentSessionId)?.messenger.scheduleFinal(parentSessionId, deliver, cancel) ??
      false,
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
    (parentSessionId, sender, message) => {
      const record = manager.getRecord(sender.id);
      return (
        !!record &&
        !retiredConversations.has(record) &&
        (deliveries.get(parentSessionId)?.messenger.send(parentSessionId, sender, message) ?? false)
      );
    },
    getAutoCompactionThreshold,
    (record) => {
      parentAllowances.delete(record.id);
      childControllers.get(record.id)?.invalidate();
    },
    (record) =>
      (childPi, getChildTools = () => childPi.getActiveTools()) => {
        const child = operations.forChild(childPi, record, getChildTools);
        childControllers.set(record.id, child);
        const messenger = createSubagentMessenger(childPi);
        let sessionId: string | undefined;
        const start = bindSubagentMessenger(childPi, messenger, (id) => {
          sessionId = id;
          deliveries.set(id, { pi: childPi, messenger });
        });
        childPi.on("session_start", (_event, ctx) => start(ctx));
        const retireDescendants = async () => {
          if (!sessionId) return;
          const descendants = manager
            .listAgents()
            .filter(
              (candidate) =>
                candidate.id !== record.id &&
                manager.tree.containsSession(record.id, candidate.parentSessionId),
            );
          for (const descendant of descendants) retiredConversations.add(descendant);
          await Promise.allSettled(descendants.map((descendant) => manager.close(descendant.id)));
        };
        childPi.on("session_shutdown", async () => {
          child.invalidate();
          messenger.flushForShutdown();
          messenger.dispose();
          if (sessionId && deliveries.get(sessionId)?.messenger === messenger)
            deliveries.delete(sessionId);
          if (childControllers.get(record.id) === child) childControllers.delete(record.id);
          await retireDescendants();
        });
        childPi.on("session_before_switch", () => child.invalidate());
        childPi.on("session_tree", async (_event, ctx) => {
          child.invalidate();
          messenger.dispose();
          start(ctx);
          await retireDescendants();
        });
        return child;
      },
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
    close: (id: string) => manager.close(id),
  });

  // --- Cross-extension RPC via pi.events ---
  let approvalOwner = new AbortController();
  let currentCtx: ExtensionContext | undefined;

  // Capture ctx from session_start for the RPC spawn handler.
  pi.on("session_start", async (_event, ctx) => {
    operations.invalidate();
    approvalOwner.abort();
    approvalOwner = new AbortController();
    parentAllowances.clear();
    currentCtx = ctx;
    currentSessionToken = {};
    applyAndEmitLoaded(
      {
        setMaxConcurrent: (n) => manager.setMaxConcurrent(n),
        setMaxDepth: (n) => manager.tree.setMaxDepth(n),
        setScopeModels: setScopeModelsEnabled,
        setFleetView: setFleetViewEnabled,
      },
      (event, payload) => pi.events.emit(event, payload),
      ctx.cwd,
    );
    startParentMessenger(ctx);
  });

  pi.on("session_before_switch", () => {
    operations.invalidate();
    approvalOwner.abort();
    parentAllowances.clear();
    currentCtx = undefined;
    currentSessionToken = undefined;
  });

  const unsubBashGateApproval = onSubagentApprovalRequest(pi, async (request) => {
    if (bashGate?.isYolo()) return { outcome: "allow", authorization: "not-reviewed" };

    const ctx = currentCtx;
    if (!ctx) return { outcome: "failure", message: "parent approval context unavailable" };
    const ownerSessionToken = currentSessionToken;
    const signal = AbortSignal.any([
      approvalOwner.signal,
      ...[ctx.signal, request.signal].filter((value): value is AbortSignal => value !== undefined),
    ]);
    const hasLiveIncarnation = () =>
      !request.agentId ||
      !request.agentSessionId ||
      manager.getRecord(request.agentId)?.incarnation === request.agentSessionId;
    const isAllowed = () => {
      if (!request.agentId || !hasLiveIncarnation()) return false;
      const allowance = parentAllowances.get(request.agentId);
      return (
        allowance?.incarnation === request.agentSessionId &&
        allowance?.keys.has(request.sessionAllowKey) === true
      );
    };
    const rememberAllowance = () => {
      if (!request.agentId || !hasLiveIncarnation()) return;
      const allowance = parentAllowances.get(request.agentId);
      const keys =
        allowance?.incarnation === request.agentSessionId && allowance
          ? allowance.keys
          : new Set<string>();
      keys.add(request.sessionAllowKey);
      parentAllowances.set(request.agentId, { incarnation: request.agentSessionId, keys });
    };
    const sessionChanged = (): BashGateApprovalResult | undefined =>
      !signal.aborted && ownerSessionToken && ownerSessionToken === currentSessionToken
        ? undefined
        : { outcome: "failure", message: "parent approval session changed" };
    const ui = ctx.ui;
    const hasUI = ctx.hasUI;
    const cwd = ctx.cwd;

    try {
      signal.throwIfAborted();
      if (isAllowed()) return { outcome: "allow-session", authorization: "human-approved" };
      if (autoMode?.isEnabled()) {
        const record = request.agentId ? manager.getRecord(request.agentId) : undefined;
        const session = record?.session;
        let decision;
        try {
          decision = await waitForAuthorization(
            autoMode.review(
              {
                toolCallId: request.toolCallId,
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
              {
                modelRegistry: ctx.modelRegistry,
                model: ctx.model,
                sessionManager: ctx.sessionManager,
                signal,
              },
            ),
            signal,
          );
        } catch (error) {
          const changed = sessionChanged();
          if (changed) return changed;
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

        const escalation = await waitForAuthorization(
          promptAutoModeEscalation({
            pi,
            ui,
            cwd,
            command: request.command,
            toolName: request.toolName,
            signal,
            isAllowed,
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
          }),
          signal,
        );
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
      return await waitForAuthorization(
        withApprovalDialog(pi.events, signal, async (): Promise<BashGateApprovalResult> => {
          const changedBeforePrompt = sessionChanged();
          if (changedBeforePrompt) return changedBeforePrompt;
          if (isAllowed()) return { outcome: "allow-session", authorization: "human-approved" };
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
              const choice = await ui.select(
                prompt,
                ["Allow", allowSession, ...(viewConversation ? [viewConversation] : []), "Deny"],
                { signal },
              );
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

              if (choice === allowSession) rememberAllowance();
              return choice === allowSession
                ? { outcome: "allow-session", authorization: "human-approved" }
                : choice === "Allow"
                  ? { outcome: "allow", authorization: "human-approved" }
                  : { outcome: "deny", source: "manual" };
            }
          } finally {
            pi.events.emit("bites:bash_gate_resolved", manualGate);
          }
        }),
        signal,
      );
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
    unsubClose: unsubCloseRpc,
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
    operations.invalidate();
    approvalOwner.abort();
    parentAllowances.clear();
    currentCtx = undefined;
    currentSessionToken = undefined;
    unsubSpawnRpc();
    unsubStopRpc();
    unsubCloseRpc();
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
  const spawn_agent = createAgentTool(pi, {
    manager,
    agentActivity,
    fleet,
    isScopeModelsEnabled,
  });

  // ---- Agent lifecycle tools ----
  const wait_agent = createWaitAgent({
    waitFor: completion.waitFor,
    getRecord: (id) => manager.getRecord(id),
  });
  const send_input = createSendInput(pi, manager);
  const close_agent = createCloseAgent(manager);
  const resume_agent = createResumeAgent(
    pi,
    manager,
    isScopeModelsEnabled,
    () => approvalOwner.signal,
  );
  operations = new SubagentController(
    pi,
    { spawn_agent, send_input, wait_agent, close_agent, resume_agent },
    manager,
    isScopeModelsEnabled,
    getAllowedTools,
  );
  pi.on("session_tree", async (_event, ctx) => {
    operations.invalidate();
    approvalOwner.abort();
    approvalOwner = new AbortController();
    parentAllowances.clear();
    currentCtx = ctx;
    currentSessionToken = {};
    parentMessenger.dispose();
    startParentMessenger(ctx);
    for (const record of manager.listAgents()) retiredConversations.add(record);
    // Navigation retires live conversations; explicit resume can recover their owned history.
    await Promise.allSettled(manager.listAgents().map((record) => manager.close(record.id)));
  });

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
  return operations;
}

export default function registerSubagents(...args: Parameters<typeof createSubagents>) {
  const controller = createSubagents(...args);
  controller.registerTools();
  return controller;
}
