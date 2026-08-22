/**
 * pi-agents — A pi extension providing Claude Code-style autonomous sub-agents.
 *
 * Tools:
 *   Agent         — LLM-callable: spawn a sub-agent
 *   WaitAgent     — LLM-callable: wait for selected sub-agents
 *   MessageAgent  — LLM-callable: send a message to a running agent
 *
 * Commands:
 *   /agents                 — Interactive agent management menu
 */

import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type BitesConfig } from "../config.js";
import { createAgentCompletionHandler } from "./agent-completion.js";
import { AgentManager } from "./agent-manager.js";
import { getAgentConfig, registerAgents, setDefaultsDisabled } from "./agent-types.js";
import { registerRpcHandlers } from "./cross-extension-rpc.js";
import { loadCustomAgents } from "./custom-agents.js";
import { registerNotificationRenderer } from "./notifications.js";
import { registerAgentsCommand } from "./agents-command.js";
import { getModelLabelFromConfig } from "./model-resolver.js";
import { registerAgentTool } from "./register-agent-tool.js";
import { registerMessageAgent } from "./register-message-agent.js";
import { registerWaitAgent } from "./register-wait-agent.js";
import { type ToolDescriptionMode } from "./settings.js";
import { type AgentActivity } from "./ui/agent-format.js";
import { FleetList } from "./ui/fleet-list.js";
import { CONVERSATION_OVERLAY_OPTIONS, ConversationViewer } from "./ui/conversation-viewer.js";
import { onSubagentApprovalRequest } from "../bash-gate/events.js";
import type { BashGateController } from "../bash-gate/index.js";
import { promptAutoModeEscalation } from "../bash-gate/automode-escalation.js";
import {
  buildReviewerTranscript,
  type AutoModeController,
  type ReviewerMessage,
} from "../automode/index.js";

// ---- Shared helpers ----

export default function (
  pi: ExtensionAPI,
  configRef: { current: BitesConfig } = { current: {} },
  autoMode?: AutoModeController,
  bashGate?: BashGateController,
) {
  // ---- Register custom notification renderer ----
  registerNotificationRenderer(pi);

  /** Reload agents from .pi/agents/*.md and merge with defaults (called on init and each Agent invocation). */
  const reloadCustomAgents = () => {
    const userAgents = loadCustomAgents(process.cwd());
    registerAgents(userAgents);
    for (const [type, cfg] of Object.entries(configRef.current.subagents ?? {})) {
      if (cfg.model) {
        const agent = getAgentConfig(type);
        if (agent) agent.model = cfg.model;
      }
    }
  };

  // Initial load
  reloadCustomAgents();

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
  });

  manager = new AgentManager(
    completion.onAgentComplete,
    undefined,
    (record) => {
      // Emit started event when agent transitions to running (including from queue)
      pi.events.emit("subagents:started", {
        id: record.id,
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

  // Capture ctx from session_start for the RPC spawn handler.
  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;
    manager.clearCompleted();
  });

  pi.on("session_before_switch", () => {
    currentCtx = undefined;
    manager.clearCompleted();
  });

  const unsubBashGateApproval = onSubagentApprovalRequest(pi, async (request) => {
    if (bashGate?.isYolo()) return { outcome: "allow" };

    const ctx = currentCtx;
    if (!ctx) return { outcome: "failure", message: "parent approval context unavailable" };
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
              labels: request.labels,
              reasons: request.reasons,
              subagentContext: session
                ? buildReviewerTranscript(session.messages as ReviewerMessage[])
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

        if (decision.outcome === "allow") return { outcome: "allow" };
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
        return escalation === "allow"
          ? { outcome: "allow" }
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
      for (;;) {
        const record = request.agentId ? manager.getRecord(request.agentId) : undefined;
        const viewConversation = record?.session ? "View conversation" : undefined;
        const choice = await ui.select(prompt, [
          "Allow",
          allowSession,
          ...(viewConversation ? [viewConversation] : []),
          "Deny",
        ]);

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
          continue;
        }

        return choice === allowSession
          ? { outcome: "allow-session" }
          : choice === "Allow"
            ? { outcome: "allow" }
            : { outcome: "deny", source: "manual" };
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
  const unsubBashGateStarted = pi.events.on("bites:bash_gate", () => fleet.bashGateStarted());
  const unsubBashGateResolved = pi.events.on("bites:bash_gate_resolved", () =>
    fleet.bashGateResolved(),
  );

  // On shutdown, abort all agents immediately and clean up.
  // If the session is going down, there's nothing left to consume agent results.
  pi.on("session_shutdown", async () => {
    unsubSpawnRpc();
    unsubStopRpc();
    unsubPingRpc();
    unsubBashGateApproval();
    unsubBashGateStarted();
    unsubBashGateResolved();
    currentCtx = undefined;
    Reflect.deleteProperty(globalThis, MANAGER_KEY);
    manager.abortAll();
    completion.dispose();
    fleet.dispose();
    manager.dispose();
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

  // ---- Disable default agents configuration ----
  // When enabled, the three hardcoded default agents (general, explore,
  // Plan) are not registered. User-defined agents from .pi/agents/*.md are
  // completely unaffected — only DEFAULT_AGENTS are suppressed.
  // Defaults to false; opt-in via `/agents → Settings` or subagents.json.
  // State lives in agent-types.ts (isDefaultsDisabled) because registerAgents
  // needs it; this wrapper just re-registers after flipping it.
  function setDisableDefaultAgents(b: boolean): void {
    setDefaultsDisabled(b);
    reloadCustomAgents(); // re-register with new setting
  }

  // ---- Agent tool description mode ----
  // "full" (default) keeps the rich Claude Code-style description; "compact"
  // swaps in a ~75% smaller one for small/local models (#91). Read once at
  // tool registration — flipping it applies on the next pi session.
  let toolDescriptionMode: ToolDescriptionMode = "full";
  function getToolDescriptionMode(): ToolDescriptionMode {
    return toolDescriptionMode;
  }
  function setToolDescriptionMode(mode: ToolDescriptionMode): void {
    toolDescriptionMode = mode;
  }

  // Grab UI context from first tool execution.
  pi.on("tool_execution_start", async (_event, ctx) => {
    fleet.setUICtx(ctx.ui);
  });

  // ---- Agent tool ----
  registerAgentTool(pi, {
    manager,
    agentActivity,
    fleet,
    reloadCustomAgents,
    isScopeModelsEnabled,
    getToolDescriptionMode,
    setScopeModelsEnabled,
    setDisableDefaultAgents,
    setToolDescriptionMode,
    setFleetViewEnabled,
  });

  // ---- WaitAgent and MessageAgent tools ----
  registerWaitAgent(pi, {
    waitFor: completion.waitFor,
    getRecord: (id) => manager.getRecord(id),
  });
  registerMessageAgent(pi, manager);

  // ---- /agents interactive menu ----
  registerAgentsCommand(pi, {
    manager,
    agentActivity,
    reloadCustomAgents,
    getModelLabelFromConfig,
    isScopeModelsEnabled,
    setScopeModelsEnabled,
    setDisableDefaultAgents,
    getToolDescriptionMode,
    setToolDescriptionMode,
    isFleetViewEnabled,
    setFleetViewEnabled,
  });
}
