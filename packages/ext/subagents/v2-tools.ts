import type { SubagentsSettings } from "./settings.js";
import { recentTurnEntries } from "./fork-history.js";
import { waitForAuthorization as waitForOperation } from "../bash-gate/pending.js";
import { lifecycleStatusLabel } from "./ui/agent-lifecycle-render.js";
import type { createSubagentMessenger } from "./subagent-messages.js";
import { resolveAgent, resolveSpawnAgent } from "./agent-types.js";
import { spawnNamed } from "./task-paths.js";
import { keyHint, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { Check } from "typebox/value";
import type { WaitAgentStatus } from "./types.js";
import { createSpawnExecution } from "./agent-tool-execute.js";
import type { AgentManager } from "./agent-manager.js";
import { extractText } from "./message-text.js";
import { getAgentStatus } from "./agent-status.js";
import { CODEX_V2_CONTRACT } from "./codex-v2-contract.js";
import { defineSubagentTool } from "./operation-context.js";
import { textResult } from "./tool-result.js";
import type { AgentActivity } from "./ui/agent-format.js";
import type { FleetList } from "./ui/fleet-list.js";
import { fitLine, sanitizeSingleLine, wrapDisplayLines } from "./ui/text-lines.js";

export function createV2Tools(
  pi: ExtensionAPI,
  deps: {
    manager: AgentManager;
    agentActivity: Map<string, AgentActivity>;
    fleet: FleetList;
    isScopeModelsEnabled: () => boolean;
    getModelDefaults?: () => Pick<SubagentsSettings, "defaultModel" | "defaultReasoningEffort">;
    getMessenger: (sessionId: string) => ReturnType<typeof createSubagentMessenger> | undefined;
  },
) {
  const roots = new Map<string, WaitAgentStatus>();
  pi.on("agent_start", (_event, ctx) => {
    roots.set(ctx.sessionManager.getSessionId(), "running");
  });
  pi.on("agent_end", (event, ctx) => {
    const last = [...event.messages].reverse().find((message) => message.role === "assistant");
    const status: WaitAgentStatus =
      last?.stopReason === "aborted"
        ? "interrupted"
        : last?.stopReason === "error"
          ? { errored: last.errorMessage ?? "unknown error" }
          : { completed: last ? extractText(last.content) || null : null };
    roots.set(ctx.sessionManager.getSessionId(), status);
  });
  pi.on("session_shutdown", () => {
    roots.clear();
  });
  const spawn = createSpawnExecution({ pi, ...deps }, (ctx, type, prompt, options, signal) =>
    spawnNamed(deps.manager, pi, ctx, type, prompt, options, signal),
  );
  const spawn_agent = defineSubagentTool({
    name: "spawn_agent",
    label: "spawn_agent",
    description: CODEX_V2_CONTRACT.tools.spawn_agent.description,
    promptGuidelines: [
      "Do not spawn sub-agents unless the user or applicable AGENTS.md/skill instructions explicitly ask for sub-agents, delegation, or parallel agent work. Requests for depth, thoroughness, research, investigation, or detailed codebase analysis do not count as permission to spawn. Role guidance never authorizes spawning. When authorized, delegate bounded independent work with a concrete benefit; keep the immediate critical-path task local. Give agents bounded, self-contained assignments and avoid duplicating delegated work. Verify delegated changes before reporting completion.",
      "Subagent tools are direct, including with Code Mode active. send_message queues information without starting idle work; followup_task assigns work. wait_agent observes your mailbox, does not consume messages or cancel children, and is distinct from Code Mode wait. Completed tasks release execution capacity; retained task paths remain addressable for later messages or follow-up.",
    ],
    parameters: Type.Unsafe<{
      task_name: string;
      message: string;
      fork_turns?: string;
      agent_type?: string;
      model?: string;
      reasoning_effort?: string;
    }>(CODEX_V2_CONTRACT.tools.spawn_agent.parameters),
    captureHistory: (args) => forkMode(args) !== "none",
    ...renderers("spawn_agent"),
    async execute(callId, args, signal, onUpdate, ctx) {
      const fork = forkMode(args);
      if (typeof fork === "bigint") {
        const entries = recentTurnEntries(ctx.sessionManager.buildContextEntries(), fork);
        ctx = {
          ...ctx,
          sessionManager: { ...ctx.sessionManager, buildContextEntries: () => entries },
        };
      }
      const role = resolveSpawnAgent(
        args.agent_type,
        fork === "all" && args.agent_type === undefined,
        ctx.parentRole,
      );
      if ("error" in role) throw new Error(role.error);
      const agent = role.agent;
      const inherited = fork === "all" && args.agent_type === undefined;
      const result = await spawn(
        callId,
        {
          message: args.message,
          model: args.model,
          reasoning_effort: args.reasoning_effort,
          taskName: args.task_name,
          forkContext: fork !== "none",
          agent: inherited
            ? { ...agent, config: { ...agent.config, model: undefined, thinking: undefined } }
            : agent,
        },
        signal,
        onUpdate,
        ctx,
      );
      const record = deps.manager.getRecord(result.agentId);
      if (!record?.taskName) throw new Error("Spawned task is no longer available");
      const value = { task_name: record.taskName };
      return { ...textResult(JSON.stringify(value), result.details), value };
    },
  });
  const list_agents = defineSubagentTool({
    name: "list_agents",
    label: "list_agents",
    description: CODEX_V2_CONTRACT.tools.list_agents.description,
    parameters: Type.Unsafe<{ path_prefix?: string }>(
      CODEX_V2_CONTRACT.tools.list_agents.parameters,
    ),
    ...renderers("list_agents"),
    async execute(_id, args, _signal, _update, ctx) {
      const sessionId = ctx.sessionManager.getSessionId();
      const { rootId } = deps.manager.taskPaths.caller(sessionId);
      const prefix =
        args.path_prefix === undefined
          ? undefined
          : deps.manager.taskPaths.resolve(sessionId, args.path_prefix);
      const agents = [
        { agent_name: "/root", agent_status: roots.get(rootId) ?? ("running" as const) },
        ...deps.manager
          .listAgents()
          .filter(
            (r) =>
              r.rootSessionId === rootId &&
              r.taskName &&
              r.session &&
              !deps.manager.isRuntimeDisposing(r.id),
          )
          .map((r) => ({ agent_name: r.taskName ?? r.id, agent_status: getAgentStatus(r) })),
      ]
        .filter((r) => !prefix || r.agent_name === prefix || r.agent_name.startsWith(`${prefix}/`))
        .sort((a, b) => a.agent_name.localeCompare(b.agent_name));
      const value = { agents };
      return { ...textResult(JSON.stringify(value), undefined), value };
    },
  });
  const messaging = (name: "send_message" | "followup_task") =>
    defineSubagentTool({
      name,
      label: name,
      description: CODEX_V2_CONTRACT.tools[name].description,
      parameters: Type.Unsafe<{ target: string; message: string }>(
        CODEX_V2_CONTRACT.tools[name].parameters,
      ),
      ...renderers(name),
      async execute(_id, args, signal, _update, ctx) {
        signal?.throwIfAborted();
        if (!args.message.trim()) throw new Error("Empty message can't be sent to an agent");
        if (!args.target.trim()) throw new Error("Target must not be empty");
        const sessionId = ctx.sessionManager.getSessionId();
        const caller = deps.manager.taskPaths.caller(sessionId);
        const root = args.target === "/root";
        if (root && name === "followup_task")
          throw new Error("Cannot send a follow-up task to root");
        const record = root ? undefined : deps.manager.taskPaths.lookup(sessionId, args.target);
        const release = record ? deps.manager.runtimes.protect(record.id) : undefined;
        try {
          if (record && (!record.session || deps.manager.isRuntimeDisposing(record.id))) {
            await deps.manager.reload(pi, ctx, record.id, signal);
            signal?.throwIfAborted();
          }
          if (record && deps.manager.isClosing(record.id))
            throw new Error("Target agent is closing");
          const targetSessionId = record?.session?.sessionManager.getSessionId() ?? caller.rootId;
          const messenger = deps.getMessenger(targetSessionId);
          if (!messenger) throw new Error("Target agent is not loaded");
          const sender = {
            id: caller.path,
            type: resolveAgent(ctx.parentRole ?? "default").type,
            title: caller.path,
          };
          const deliver = () =>
            messenger.queueOnly(targetSessionId, sender, args.message, name === "followup_task");
          // An interrupt acknowledges submission before Pi finishes unwinding tools.
          // Wait for that turn before committing fresh work to the retained session.
          if (
            name === "followup_task" &&
            record?.status === "stopped" &&
            record.abort?.source === "interrupt"
          ) {
            if (record.promise)
              await (signal ? waitForOperation(record.promise, signal) : record.promise);
            signal?.throwIfAborted();
          }
          const accepted =
            name === "followup_task" && record
              ? deps.manager.followup(
                  record.id,
                  deliver,
                  () => messenger.observe().pendingTasks > 0,
                )
              : deliver();
          if (!accepted) throw new Error("Input was not submitted to target agent");
          if (record) {
            deps.fleet.ensureTimer();
            deps.fleet.update();
            pi.events.emit("subagents:steered", { id: record.id, message: args.message });
          }
          return {
            ...textResult("", {
              target: record?.taskName ?? "/root",
              status: name === "send_message" ? "queued" : "submitted",
            }),
            value: "" as const,
          };
        } finally {
          release?.();
        }
      },
    });
  const interrupt_agent = defineSubagentTool({
    name: "interrupt_agent",
    label: "interrupt_agent",
    description: CODEX_V2_CONTRACT.tools.interrupt_agent.description,
    parameters: Type.Unsafe<{ target: string }>(CODEX_V2_CONTRACT.tools.interrupt_agent.parameters),
    ...renderers("interrupt_agent"),
    async execute(_id, args, signal, _update, ctx) {
      signal?.throwIfAborted();
      if (!args.target.trim()) throw new Error("Target must not be empty");
      const sessionId = ctx.sessionManager.getSessionId();
      if (args.target === "/root") throw new Error("Cannot interrupt root");
      const record = deps.manager.taskPaths.lookup(sessionId, args.target);
      if (deps.manager.taskPaths.caller(sessionId).path === record.taskName)
        throw new Error("Cannot interrupt self");
      const previous_status = record.session ? getAgentStatus(record) : ("not_found" as const);
      // Submission, not settlement, is the commit point. Later caller cancellation
      // cannot retract an accepted interrupt or retire its conversation.
      void deps.manager.interruptTurn(record.id).catch(() => {});
      const status = lifecycleStatusLabel(previous_status, "pending_init");
      const value = { previous_status };
      return { ...textResult(JSON.stringify(value), { status: `previous: ${status}` }), value };
    },
  });
  const wait_agent = defineSubagentTool({
    name: "wait_agent",
    label: "wait_agent",
    description: CODEX_V2_CONTRACT.tools.wait_agent.description,
    parameters: Type.Unsafe<{ timeout_ms?: number }>(CODEX_V2_CONTRACT.tools.wait_agent.parameters),
    ...renderers("wait_agent"),
    async execute(_id, args, signal, _update, ctx) {
      const requested = args.timeout_ms ?? 30_000;
      if (requested > 3_600_000) throw new Error("timeout_ms must not exceed 3600000");
      const timeout = Math.max(10_000, requested);
      const messenger = deps.getMessenger(ctx.sessionManager.getSessionId());
      if (!messenger) throw new Error("Mailbox is unavailable");
      const outcome = await messenger.wait(timeout, signal);
      const summary =
        outcome === "mail"
          ? "Wait completed."
          : outcome === "input"
            ? "Wait interrupted by new input."
            : "Wait timed out.";
      const notice =
        requested < timeout
          ? `\n\nRequested timeout of ${requested}ms was clamped to the minimum of ${timeout}ms.`
          : "";
      const value = { message: summary + notice, timed_out: outcome === "timeout" };
      return { ...textResult(JSON.stringify(value), { status: summary }), value };
    },
  });
  return {
    interrupt_agent,
    wait_agent,
    spawn_agent,
    list_agents,
    send_message: messaging("send_message"),
    followup_task: messaging("followup_task"),
  };
}

const listResultSchema = Type.Unsafe<{
  agents: Array<{ agent_name: string; agent_status: WaitAgentStatus }>;
}>(CODEX_V2_CONTRACT.tools.list_agents.output_schema);

type RenderState = { error?: string; agents?: string[]; status?: string; savedWait?: string };

/** The call row owns status/errors; results never duplicate it. */
function renderers(name: string) {
  return {
    renderCall(
      args: {
        task_name?: string;
        fork_turns?: string;
        path_prefix?: string;
        target?: string;
        timeout_ms?: number;
        // Read-only saved V1 calls; these arguments are not accepted by executors.
        targets?: unknown[];
        agent_type?: string;
      },
      theme: { bold(s: string): string; fg(color: "accent" | "dim", s: string): string },
      context: { state: RenderState; expanded: boolean },
    ) {
      return {
        render(width: number) {
          const summary = sanitizeSingleLine(
            name === "wait_agent"
              ? Array.isArray(args.targets)
                ? `${args.targets.length} agents`
                : `${Math.max(10_000, args.timeout_ms ?? 30_000)}ms`
              : (args.task_name ?? args.agent_type ?? args.target ?? args.path_prefix ?? "/root"),
          );
          let fork = "";
          if (name === "spawn_agent") {
            try {
              fork = ` fork=${forkMode(args)}`;
            } catch {
              fork = " fork=invalid";
            }
          }
          const lines = [
            fitLine(
              theme.bold(name) +
                theme.fg(
                  "accent",
                  ` ${summary}${fork}${context.state.status ? ` ${context.state.status}` : ""}`,
                ),
              width,
            ),
          ];
          const agents = context.state.savedWait
            ? wrapDisplayLines(context.state.savedWait, Math.max(1, width))
            : context.state.agents;
          if (agents?.length) {
            lines.push("");
            for (const line of context.expanded ? agents : agents.slice(0, 8))
              lines.push(fitLine(theme.fg("dim", line), width));
            if (!context.expanded && agents.length > 8) {
              let hint = "ctrl+o to expand";
              try {
                hint = keyHint("app.tools.expand", "to expand");
              } catch {
                /* No interactive keybindings in print mode. */
              }
              lines.push(fitLine(theme.fg("dim", `(${hint})`), width));
            }
          }
          if (typeof context.state.error === "string")
            lines.push(
              "",
              fitLine(theme.fg("dim", sanitizeSingleLine(context.state.error)), width),
            );
          return lines;
        },
        invalidate() {},
      };
    },
    renderResult(
      result: { content: Array<{ type: string; text?: string }>; details?: unknown },
      _options: unknown,
      _theme: unknown,
      context: { state: RenderState; isError: boolean },
    ) {
      const details = result.details as
        | { status?: string; agents?: unknown[]; outcome?: string }
        | undefined;
      if (
        name === "wait_agent" &&
        Array.isArray(details?.agents) &&
        typeof details.outcome === "string"
      )
        context.state.savedWait = result.content
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("\n");
      if (typeof details?.status === "string")
        context.state.status = sanitizeSingleLine(details.status);
      if (context.isError)
        context.state.error = result.content
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("\n");
      else if (name === "list_agents") {
        try {
          const payload: unknown = JSON.parse(
            result.content
              .filter((b) => b.type === "text")
              .map((b) => b.text)
              .join("\n"),
          );
          if (Check(listResultSchema, payload))
            context.state.agents = payload.agents.map((agent) => {
              const status =
                typeof agent.agent_status === "string"
                  ? agent.agent_status
                  : "completed" in agent.agent_status
                    ? "completed"
                    : "errored";
              return sanitizeSingleLine(`${agent.agent_name} ${status}`);
            });
        } catch {
          /* A partial/restored result may not yet contain a complete list. */
        }
      }
      return new Container();
    },
  };
}

function forkMode(args: unknown): "all" | "none" | bigint {
  const value =
    typeof args === "object" && args !== null && "fork_turns" in args ? args.fork_turns : undefined;
  const fork = typeof value === "string" ? value.trim().toLowerCase() || "all" : "all";
  if (fork === "all" || fork === "none") return fork;
  // Match the pinned 64-bit usize parser, including leading + and zeroes.
  if (/^\+?[0-9]+$/.test(fork)) {
    const count = BigInt(fork);
    if (count > 0n && count <= 18446744073709551615n) return count;
  }
  throw new Error("fork_turns must be `none`, `all`, or a positive integer string");
}
