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
import { AgentManager } from "./agent-manager.js";
import { registerAgents, setDefaultsDisabled } from "./agent-types.js";
import { registerRpcHandlers } from "./cross-extension-rpc.js";
import { loadCustomAgents } from "./custom-agents.js";
import { buildEventData } from "./event-data.js";
import { GroupJoinManager } from "./group-join.js";
import {
  buildNotificationDetails,
  formatTaskNotification,
  registerNotificationRenderer,
} from "./notifications.js";
import { registerAgentsCommand } from "./agents-command.js";
import { getModelLabelFromConfig, registerAgentTool } from "./register-agent-tool.js";
import { registerResultTools } from "./register-result-tools.js";
import { SubagentScheduler } from "./schedule.js";
import { resolveStorePath, ScheduleStore } from "./schedule-store.js";
import { type ToolDescriptionMode } from "./settings.js";
import { type AgentRecord, type JoinMode, type NotificationDetails } from "./types.js";
import { type AgentActivity } from "./ui/agent-format.js";
import { FleetList, type FleetUICtx } from "./ui/fleet-list.js";

export { renderRunningAgentStatus } from "./running-status.js";

// ---- Shared helpers ----

export default function (pi: ExtensionAPI) {
  // ---- Register custom notification renderer ----
  registerNotificationRenderer(pi);

  /** Reload agents from .pi/agents/*.md and merge with defaults (called on init and each Agent invocation). */
  const reloadCustomAgents = () => {
    const userAgents = loadCustomAgents(process.cwd());
    registerAgents(userAgents);
  };

  // Initial load
  reloadCustomAgents();

  // ---- Agent activity tracking ----
  const agentActivity = new Map<string, AgentActivity>();

  // ---- Cancellable pending notifications ----
  // Holds notifications briefly so get_subagent_result can cancel them
  // before they reach pi.sendMessage (fire-and-forget).
  const pendingNudges = new Map<string, ReturnType<typeof setTimeout>>();
  const NUDGE_HOLD_MS = 200;

  function scheduleNudge(key: string, send: () => void, delay = NUDGE_HOLD_MS) {
    cancelNudge(key);
    pendingNudges.set(
      key,
      setTimeout(() => {
        pendingNudges.delete(key);
        try {
          send();
        } catch {
          /* ignore stale completion side-effect errors */
        }
      }, delay),
    );
  }

  function cancelNudge(key: string) {
    const timer = pendingNudges.get(key);
    if (timer != null) {
      clearTimeout(timer);
      pendingNudges.delete(key);
    }
  }

  // ---- Individual nudge helper (async join mode) ----
  function emitIndividualNudge(record: AgentRecord) {
    if (record.resultConsumed) return; // re-check at send time

    const notification = formatTaskNotification(record, 500);
    const footer = record.outputFile ? `\nFull transcript available at: ${record.outputFile}` : "";

    pi.sendMessage<NotificationDetails>(
      {
        customType: "subagent-notification",
        content: notification + footer,
        display: true,
        details: buildNotificationDetails(record, 500, agentActivity.get(record.id)),
      },
      { deliverAs: "followUp", triggerTurn: true },
    );
  }

  function sendIndividualNudge(record: AgentRecord) {
    agentActivity.delete(record.id);
    fleet.onAgentFinished(record.id);
    scheduleNudge(record.id, () => emitIndividualNudge(record));
  }

  // ---- Group join manager ----
  const groupJoin = new GroupJoinManager((records, partial) => {
    for (const r of records) {
      agentActivity.delete(r.id);
      fleet.onAgentFinished(r.id);
    }

    const groupKey = `group:${records.map((r) => r.id).join(",")}`;
    scheduleNudge(groupKey, () => {
      // Re-check at send time
      const unconsumed = records.filter((r) => !r.resultConsumed);
      if (unconsumed.length === 0) {
        return;
      }

      const notifications = unconsumed.map((r) => formatTaskNotification(r, 300)).join("\n\n");
      const label = partial
        ? `${unconsumed.length} agent(s) finished (partial — others still running)`
        : `${unconsumed.length} agent(s) finished`;

      const [first, ...rest] = unconsumed;
      const details = buildNotificationDetails(first, 300, agentActivity.get(first.id));
      if (rest.length > 0) {
        details.others = rest.map((r) => buildNotificationDetails(r, 300, agentActivity.get(r.id)));
      }

      pi.sendMessage<NotificationDetails>(
        {
          customType: "subagent-notification",
          content: `Background agent group completed: ${label}\n\n${notifications}\n\nUse get_subagent_result for full output.`,
          display: true,
          details,
        },
        { deliverAs: "followUp", triggerTurn: true },
      );
    });
  }, 30_000);

  // Background completion: route through group join or send individual nudge
  const manager = new AgentManager(
    (record) => {
      // Emit lifecycle event based on terminal status
      const isError =
        record.status === "error" || record.status === "stopped" || record.status === "aborted";
      const eventData = buildEventData(record);
      if (isError) {
        pi.events.emit("subagents:failed", eventData);
      } else {
        pi.events.emit("subagents:completed", eventData);
      }

      // Persist final record for cross-extension history reconstruction
      pi.appendEntry("subagents:record", {
        id: record.id,
        type: record.type,
        description: record.description,
        status: record.status,
        result: record.result,
        error: record.error,
        startedAt: record.startedAt,
        completedAt: record.completedAt,
      });

      // Skip notification if result was already consumed via get_subagent_result
      if (record.resultConsumed) {
        agentActivity.delete(record.id);
        fleet.onAgentFinished(record.id);
        return;
      }

      // If this agent is pending batch finalization (debounce window still open),
      // don't send an individual nudge — finalizeBatch will pick it up retroactively.
      if (currentBatchAgents.some((a) => a.id === record.id)) {
        return;
      }

      const result = groupJoin.onAgentComplete(record);
      if (result === "pass") {
        sendIndividualNudge(record);
      }
      // 'held' → do nothing, group will fire later
      // 'delivered' → group callback already fired
    },
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

  // ---- Subagent scheduler ----
  // Session-scoped: store is constructed inside session_start once sessionId
  // is available. Mirrors pi-chonky-tasks's session-scoped task store —
  // schedules reset on /new, restore on /resume.
  const scheduler = new SubagentScheduler();

  function startScheduler(ctx: ExtensionContext) {
    try {
      const sessionId = ctx.sessionManager?.getSessionId?.();
      if (!sessionId) return; // sessionId not yet available — try again on next event
      const path = resolveStorePath(ctx.cwd, sessionId);
      const store = new ScheduleStore(path);
      scheduler.start(pi, ctx, manager, store);
      pi.events.emit("subagents:scheduler_ready", { sessionId, jobCount: store.list().length });
    } catch (err) {
      // Scheduling is non-essential — log and move on so the rest of the
      // extension keeps working if e.g. .pi/ is unwritable.
      console.warn("[pi-subagents] Failed to start scheduler:", err);
    }
  }

  // Capture ctx from session_start for RPC spawn handler + start the scheduler.
  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;
    manager.clearCompleted(true);
    if (isSchedulingEnabled() && !scheduler.isActive()) startScheduler(ctx);
  });

  pi.on("session_before_switch", () => {
    manager.clearCompleted(true);
    scheduler.stop();
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
    scheduler.stop();
    manager.abortAll();
    for (const timer of pendingNudges.values()) clearTimeout(timer);
    pendingNudges.clear();
    fleet.dispose();
    manager.dispose();
  });

  // Claude Code-style FleetView: navigable list of main + subagents above the editor.
  const fleet = new FleetList(manager, agentActivity);
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

  // Master switch for the schedule subagent feature. Defaults to enabled.
  // Read once at extension init (before tool registration) so the Agent tool's
  // param schema reflects the persisted setting. Runtime toggles via /agents
  // → Settings short-circuit the menu entry + the execute-time addJob path
  // immediately, but the schema-level removal only takes effect on next
  // extension load (next pi session). Documented in CHANGELOG/README.
  let schedulingEnabled = true;
  function isSchedulingEnabled(): boolean {
    return schedulingEnabled;
  }
  function setSchedulingEnabled(b: boolean) {
    schedulingEnabled = b;
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

  // ---- Batch tracking for smart join mode ----
  // Collects background agent IDs spawned in the current turn for smart grouping.
  // Uses a debounced timer: each new agent resets the 100ms window so that all
  // parallel tool calls (which may be dispatched across multiple microtasks by the
  // framework) are captured in the same batch.
  let currentBatchAgents: { id: string; joinMode: JoinMode }[] = [];
  let batchFinalizeTimer: ReturnType<typeof setTimeout> | undefined;
  let batchCounter = 0;

  /** Finalize the current batch: if 2+ smart-mode agents, register as a group. */
  function finalizeBatch() {
    batchFinalizeTimer = undefined;
    const batchAgents = [...currentBatchAgents];
    currentBatchAgents = [];

    const smartAgents = batchAgents.filter((a) => a.joinMode === "smart" || a.joinMode === "group");
    if (smartAgents.length >= 2) {
      const groupId = `batch-${++batchCounter}`;
      const ids = smartAgents.map((a) => a.id);
      groupJoin.registerGroup(groupId, ids);
      // Retroactively process agents that already completed during the debounce window.
      // Their onComplete fired but was deferred (agent was in currentBatchAgents),
      // so we feed them into the group now.
      for (const id of ids) {
        const record = manager.getRecord(id);
        if (!record) continue;
        record.groupId = groupId;
        if (record.completedAt != null && !record.resultConsumed) {
          groupJoin.onAgentComplete(record);
        }
      }
    } else {
      // No group formed — send individual nudges for any agents that completed
      // during the debounce window and had their notification deferred.
      for (const { id } of batchAgents) {
        const record = manager.getRecord(id);
        if (record?.completedAt != null && !record.resultConsumed) {
          sendIndividualNudge(record);
        }
      }
    }
  }

  function trackBatchAgent(id: string, joinMode: JoinMode) {
    currentBatchAgents.push({ id, joinMode });
    if (batchFinalizeTimer) clearTimeout(batchFinalizeTimer);
    batchFinalizeTimer = setTimeout(finalizeBatch, 100);
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
    scheduler,
    reloadCustomAgents,
    isSchedulingEnabled,
    isScopeModelsEnabled,
    getToolDescriptionMode,
    setDefaultJoinMode,
    setSchedulingEnabled,
    setScopeModelsEnabled,
    setDisableDefaultAgents,
    setToolDescriptionMode,
    setFleetViewEnabled,
    getDefaultJoinMode,
    trackBatchAgent,
  });

  // ---- get_subagent_result + steer_subagent tools ----
  registerResultTools(pi, manager, cancelNudge);

  // ---- /agents interactive menu ----
  registerAgentsCommand(pi, {
    manager,
    agentActivity,
    scheduler,
    reloadCustomAgents,
    getModelLabelFromConfig,
    getDefaultJoinMode,
    setDefaultJoinMode,
    isSchedulingEnabled,
    setSchedulingEnabled,
    isScopeModelsEnabled,
    setScopeModelsEnabled,
    setDisableDefaultAgents,
    getToolDescriptionMode,
    setToolDescriptionMode,
    isFleetViewEnabled,
    setFleetViewEnabled,
  });
}
