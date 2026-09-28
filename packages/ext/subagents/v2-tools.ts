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
import { fitLine, sanitizeSingleLine } from "./ui/text-lines.js";

export function createV2Tools(
  pi: ExtensionAPI,
  deps: {
    manager: AgentManager;
    agentActivity: Map<string, AgentActivity>;
    fleet: FleetList;
    isScopeModelsEnabled: () => boolean;
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
    parameters: Type.Unsafe<{
      task_name: string;
      message: string;
      fork_turns?: string;
      agent_type?: string;
      model?: string;
      reasoning_effort?: string;
    }>(CODEX_V2_CONTRACT.tools.spawn_agent.parameters),
    captureHistory: (args) => forkMode(args) === "all",
    ...renderers("spawn_agent"),
    async execute(callId, args, signal, onUpdate, ctx) {
      const fork = forkMode(args);
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
          forkContext: fork === "all",
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
        if (
          record &&
          (!record.session ||
            deps.manager.isClosing(record.id) ||
            deps.manager.isRuntimeDisposing(record.id))
        )
          throw new Error("Target agent is not loaded");
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
        const accepted =
          name === "followup_task" && record
            ? deps.manager.followup(record.id, deliver, () => messenger.observe().pendingTasks > 0)
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
      },
    });
  return {
    spawn_agent,
    list_agents,
    send_message: messaging("send_message"),
    followup_task: messaging("followup_task"),
  };
}

const listResultSchema = Type.Unsafe<{
  agents: Array<{ agent_name: string; agent_status: WaitAgentStatus }>;
}>(CODEX_V2_CONTRACT.tools.list_agents.output_schema);

type RenderState = { error?: string; agents?: string[]; status?: string };

/** The call row owns status/errors; results never duplicate it. */
function renderers(name: string) {
  return {
    renderCall(
      args: { task_name?: string; path_prefix?: string; target?: string },
      theme: { bold(s: string): string; fg(color: "accent" | "dim", s: string): string },
      context: { state: RenderState; expanded: boolean },
    ) {
      return {
        render(width: number) {
          const summary = sanitizeSingleLine(
            args.task_name ?? args.target ?? args.path_prefix ?? "/root",
          );
          const lines = [
            fitLine(
              theme.bold(name) +
                theme.fg(
                  "accent",
                  ` ${summary}${context.state.status ? ` ${context.state.status}` : ""}`,
                ),
              width,
            ),
          ];
          const agents = context.state.agents;
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
      const details = result.details as { status?: string } | undefined;
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

function forkMode(args: unknown): "all" | "none" {
  const value =
    typeof args === "object" && args !== null && "fork_turns" in args ? args.fork_turns : undefined;
  const fork = typeof value === "string" ? value.trim().toLowerCase() || "all" : "all";
  if (fork === "all" || fork === "none") return fork;
  throw new Error(
    "This integration slice supports fork_turns all or none; recent-turn forks are not implemented.",
  );
}
