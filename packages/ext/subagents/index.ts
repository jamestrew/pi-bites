/**
 * pi-agents — A pi extension providing Claude Code-style autonomous sub-agents.
 *
 * Tools:
 *   Agent             — LLM-callable: spawn a sub-agent
 *   get_subagent_result  — LLM-callable: check background agent status/result
 *   steer_subagent       — LLM-callable: send a steering message to a running agent
 *
 * Commands:
 *   /agents                 — Interactive agent management menu
 */

import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type BitesConfig } from "../config.js";
import { createAgentCompletionHandler } from "./agent-completion.js";
import { AgentManager } from "./agent-manager.js";
import { SUBAGENT_TOOL_NAMES } from "./agent-runner.js";
import { getAgentConfig, registerAgents, setDefaultsDisabled } from "./agent-types.js";
import { registerRpcHandlers } from "./cross-extension-rpc.js";
import { loadCustomAgents } from "./custom-agents.js";
import { registerNotificationRenderer } from "./notifications.js";
import { registerAgentsCommand } from "./agents-command.js";
import { getModelLabelFromConfig, registerAgentTool } from "./register-agent-tool.js";
import { registerResultTools } from "./register-result-tools.js";
import { type ToolDescriptionMode } from "./settings.js";
import { type JoinMode } from "./types.js";
import { type AgentActivity } from "./ui/agent-format.js";
import { FleetList, type FleetUICtx } from "./ui/fleet-list.js";

// ---- Shared helpers ----

export default function (pi: ExtensionAPI, configRef: { current: BitesConfig } = { current: {} }) {
  // ---- Register custom notification renderer ----
  registerNotificationRenderer(pi);

  /** Reload agents from .pi/agents/*.md and merge with defaults (called on init and each Agent invocation). */
  const reloadCustomAgents = () => {
    const userAgents = loadCustomAgents(process.cwd());
    registerAgents(userAgents);
    for (const [type, cfg] of Object.entries(configRef.current.subagents ?? {})) {
      if (cfg?.model) {
        const agent = getAgentConfig(type);
        if (agent) agent.model = cfg.model;
      }
    }
  };

  // Initial load
  reloadCustomAgents();

  // ---- Agent activity tracking ----
  const agentActivity = new Map<string, AgentActivity>();

  function hasActionableBackgroundAgent(): boolean {
    return manager
      .listAgents()
      .some(
        (r) =>
          r.isBackground === true &&
          (r.status === "running" || r.status === "queued" || !r.resultConsumed),
      );
  }

  function updateHelperToolsActive(): void {
    if (typeof pi.getActiveTools !== "function" || typeof pi.setActiveTools !== "function") return;
    const helperTools = [SUBAGENT_TOOL_NAMES.GET_RESULT, SUBAGENT_TOOL_NAMES.STEER];
    const current = pi.getActiveTools();
    const next = hasActionableBackgroundAgent()
      ? [...new Set([...current, ...helperTools])]
      : current.filter((name) => !helperTools.includes(name as (typeof helperTools)[number]));
    pi.setActiveTools(next);
  }

  let manager: AgentManager;
  let fleet: FleetList;
  const completion = createAgentCompletionHandler({
    pi,
    getRecord: (id) => manager.getRecord(id),
    onAgentFinishedUI: (id) => {
      agentActivity.delete(id);
      fleet.onAgentFinished(id);
    },
    onActionableAgentsChanged: updateHelperToolsActive,
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
  (globalThis as any)[MANAGER_KEY] = {
    waitForAll: () => manager.waitForAll(),
    hasRunning: () => manager.hasRunning(),
    spawn: (piRef: any, ctx: any, type: string, prompt: string, options: any) =>
      manager.spawn(piRef, ctx, type, prompt, options),
    getRecord: (id: string) => manager.getRecord(id),
  };

  // --- Cross-extension RPC via pi.events ---
  let currentCtx: ExtensionContext | undefined;

  // Capture ctx from session_start for the RPC spawn handler.
  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;
    manager.clearCompleted(true);
    updateHelperToolsActive();
  });

  pi.on("session_before_switch", () => {
    manager.clearCompleted(true);
    updateHelperToolsActive();
  });

  const unsubBashGateApproval = pi.events.on(
    "subagents:bash_gate:approval",
    async (raw: unknown) => {
      const request = raw as {
        requestId?: string;
        title?: string;
        command?: string;
        labels?: string[];
        reasons?: string[];
        sessionAllowKey?: string;
      };
      if (!request.requestId) return;

      const ackChannel = `subagents:bash_gate:approval:ack:${request.requestId}`;
      const replyChannel = `subagents:bash_gate:approval:reply:${request.requestId}`;
      pi.events.emit(ackChannel, {});

      const ui = currentCtx?.ui;
      if (!currentCtx?.hasUI || !ui) {
        pi.events.emit(replyChannel, { decision: "deny" });
        return;
      }

      try {
        const labels = request.labels?.join(", ") || "unknown rule";
        const reasons = request.reasons?.filter(Boolean).join("; ");
        const prompt = reasons
          ? `🔒 ${request.title ?? "Subagent"} requests bash approval: ${request.command ?? ""}\n${reasons} (${labels})`
          : `🔒 ${request.title ?? "Subagent"} requests bash approval: ${request.command ?? ""}\n${labels}`;
        const choice = await ui.select(prompt, [
          "Allow",
          `Allow for session ("${request.sessionAllowKey ?? labels}")`,
          "Deny",
        ]);

        pi.events.emit(replyChannel, {
          decision: choice?.startsWith("Allow for session")
            ? "allow-session"
            : choice === "Allow"
              ? "allow"
              : "deny",
        });
      } catch {
        pi.events.emit(replyChannel, { decision: "deny" });
      }
    },
  );

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

  // On shutdown, abort all agents immediately and clean up.
  // If the session is going down, there's nothing left to consume agent results.
  pi.on("session_shutdown", async () => {
    unsubSpawnRpc();
    unsubStopRpc();
    unsubPingRpc();
    unsubBashGateApproval();
    currentCtx = undefined;
    delete (globalThis as any)[MANAGER_KEY];
    manager.abortAll();
    updateHelperToolsActive();
    completion.dispose();
    fleet.dispose();
    manager.dispose();
  });

  // Claude Code-style FleetView: navigable list of main + subagents above the editor.
  fleet = new FleetList(manager, agentActivity);
  let fleetViewEnabled = true;
  function isFleetViewEnabled(): boolean {
    return fleetViewEnabled;
  }
  function setFleetViewEnabled(b: boolean): void {
    fleetViewEnabled = b;
    fleet.setEnabled(b);
  }

  // ---- Join mode configuration ----
  let defaultJoinMode: JoinMode = "smart";
  function getDefaultJoinMode(): JoinMode {
    return defaultJoinMode;
  }
  function setDefaultJoinMode(mode: JoinMode) {
    defaultJoinMode = mode;
  }

  // ---- Scope models configuration ----
  // When enabled, subagent model choices are validated against `enabledModels`
  // from pi's settings — both global `<agentDir>/settings.json` and
  // project-local `<cwd>/.pi/settings.json` (project overrides global).
  // Off by default; opt-in via `/agents → Settings`. See docstring on
  // SubagentsSettings.scopeModels for the hard-error vs warn-and-proceed
  // policy and its rationale.
  let scopeModelsEnabled = false;
  function isScopeModelsEnabled(): boolean {
    return scopeModelsEnabled;
  }
  function setScopeModelsEnabled(enabled: boolean): void {
    scopeModelsEnabled = enabled;
  }

  // ---- Disable default agents configuration ----
  // When enabled, the three hardcoded default agents (general-purpose, explore,
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
    fleet.setUICtx(ctx.ui as unknown as FleetUICtx);
  });

  // ---- Agent tool ----
  registerAgentTool(pi, {
    manager,
    agentActivity,
    fleet,
    reloadCustomAgents,
    isScopeModelsEnabled,
    getToolDescriptionMode,
    setDefaultJoinMode,
    setScopeModelsEnabled,
    setDisableDefaultAgents,
    setToolDescriptionMode,
    setFleetViewEnabled,
    getDefaultJoinMode,
    trackSpawned: completion.trackSpawned,
    updateHelperToolsActive,
  });

  // ---- get_subagent_result + steer_subagent tools ----
  registerResultTools(pi, manager, completion.cancelNudge, updateHelperToolsActive);

  // ---- /agents interactive menu ----
  registerAgentsCommand(pi, {
    manager,
    agentActivity,
    reloadCustomAgents,
    getModelLabelFromConfig,
    getDefaultJoinMode,
    setDefaultJoinMode,
    isScopeModelsEnabled,
    setScopeModelsEnabled,
    setDisableDefaultAgents,
    getToolDescriptionMode,
    setToolDescriptionMode,
    isFleetViewEnabled,
    setFleetViewEnabled,
  });
}
