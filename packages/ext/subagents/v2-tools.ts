import {
  observationReceiptRenderers,
  snapshotAgent,
  type AgentSnapshot,
  type WaitSnapshot,
} from "./ui/observation-receipt.js";
import { taskReceiptRenderers } from "./ui/task-receipt.js";
import type { SubagentsSettings } from "./settings.js";
import { recentTurnEntries } from "./fork-history.js";
import { lifecycleStatusLabel } from "./ui/agent-lifecycle-render.js";
import type { TaskDelivery } from "./agent-delivery.js";
import { resolveAgent, resolveSpawnAgent } from "./agent-types.js";
import { spawnNamed } from "./task-paths.js";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AgentRecord, WaitAgentStatus } from "./types.js";
import { createSpawnExecution } from "./agent-tool-execute.js";
import type { AgentManager } from "./agent-manager.js";
import { extractText } from "./message-text.js";
import { getAgentStatus } from "./agent-status.js";
import { defineSubagentTool } from "./operation-context.js";
import { SubagentOperationError, textResult } from "./tool-result.js";
import type { SubagentMessageDetails } from "./subagent-messages.js";
import type { FleetList } from "./ui/fleet-list.js";

export function createV2Tools(
  pi: ExtensionAPI,
  deps: TaskDelivery & {
    manager: AgentManager;
    fleet: FleetList;
    getModelDefaults?: () => Pick<SubagentsSettings, "defaultModel" | "defaultReasoningEffort">;
  },
) {
  const roots = new Map<string, WaitAgentStatus>();
  const terminalRoots = new Map<string, { status: WaitAgentStatus; aborted: boolean }>();
  pi.on("agent_start", (_event, ctx) => {
    const id = ctx.sessionManager.getSessionId();
    roots.set(id, "running");
    terminalRoots.delete(id);
  });
  pi.on("agent_end", (event, ctx) => {
    const last = [...event.messages].reverse().find((message) => message.role === "assistant");
    const status: WaitAgentStatus =
      last?.stopReason === "error"
        ? { errored: last.errorMessage ?? "unknown error" }
        : { completed: last ? extractText(last.content) || null : null };
    // agent_end precedes retries, compaction, and automatic continuation.
    terminalRoots.set(ctx.sessionManager.getSessionId(), {
      status,
      aborted: last?.stopReason === "aborted",
    });
  });
  pi.on("agent_settled", (event: { aborted?: boolean }, ctx) => {
    const id = ctx.sessionManager.getSessionId();
    const terminal = terminalRoots.get(id);
    roots.set(
      id,
      (event.aborted ?? terminal?.aborted)
        ? "interrupted"
        : (terminal?.status ?? { completed: null }),
    );
    terminalRoots.delete(id);
  });
  pi.on("session_shutdown", () => {
    roots.clear();
    terminalRoots.clear();
  });
  const spawn = createSpawnExecution({ pi, ...deps }, (ctx, type, prompt, options, signal) =>
    spawnNamed(deps.manager, pi, ctx, type, prompt, options, signal),
  );
  const spawn_agent = defineSubagentTool({
    name: "spawn_agent",
    label: "spawn_agent",
    description:
      '\n        No picker-visible model overrides are currently loaded.\n        Spawns an agent to work on the specified task. If your current task is `/root/task1` and you spawn_agent with task_name "task_3" the agent will have canonical task name `/root/task1/task_3`.\nYou are then able to refer to this agent as `task_3` or `/root/task1/task_3` interchangeably. However an agent `/root/task2/task_3` would only be able to communicate with this agent via its canonical name `/root/task1/task_3`.\nThe spawned agent will have the same tools as you and the ability to spawn its own subagents.\nSpawned agents inherit your current model by default. Omit `model` to use that preferred default; set `model` only when an explicit override is needed.\nIt will be able to send you and other running agents messages, and its final answer will be provided to you when it finishes.\nThe new agent\'s canonical task name will be provided to it along with the message.\n\nNote that passing `fork_turns="none"` will not pass any surrounding context to the spawned subagent, which may cause the agent to lack the context it needs to complete its task, whereas `fork_turns="all"` will provide the subagent with all surrounding context.',
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
    }>({
      type: "object",
      properties: {
        agent_type: {
          type: "string",
          description:
            'Agent type override for the new agent. Omit unless explicitly asked. The selected role applies regardless of how much parent history is inherited.\nAvailable roles:\ndefault: {\nDefault agent.\n}\nexplorer: {\nUse `explorer` for specific codebase questions.\nExplorers are fast and authoritative.\nThey must be used to ask specific, well-scoped questions on the codebase.\nRules:\n- In order to avoid redundant work, you should avoid exploring the same problem that explorers have already covered. Typically, you should trust the explorer results without additional verification. You are still allowed to inspect the code yourself to gain the needed context!\n- You are encouraged to spawn up multiple explorers in parallel when you have multiple distinct questions to ask about the codebase that can be answered independently. This allows you to get more information faster without waiting for one question to finish before asking the next. While waiting for the explorer results, you can continue working on other local tasks that do not depend on those results. This parallelism is a key advantage of delegation, so use it whenever you have multiple questions to ask.\n- Reuse existing explorers for related questions.\n}\nworker: {\nUse for execution and production work.\nTypical tasks:\n- Implement part of a feature\n- Fix tests or bugs\n- Split large refactors into independent chunks\nRules:\n- Explicitly assign **ownership** of the task (files / responsibility). When the subtask involves code changes, you should clearly specify which files or modules the worker is responsible for. This helps avoid merge conflicts and ensures accountability. For example, you can say "Worker 1 is responsible for updating the authentication module, while Worker 2 will handle the database layer." By defining clear ownership, you can delegate more effectively and reduce coordination overhead.\n- Always tell workers they are **not alone in the codebase**, and they should not revert the edits made by others, and they should adjust their implementation to accommodate the changes made by others. This is important because there may be multiple workers making changes in parallel, and they need to be aware of each other\'s work to avoid conflicts and ensure a cohesive final product.\n}',
        },
        fork_turns: {
          type: "string",
          description:
            "Optional number of turns to fork. Defaults to `all`. Use `none`, `all`, or a positive integer string such as `3` to fork only the most recent turns.",
        },
        message: {
          type: "string",
          description: "Initial plain-text task for the new agent.",
        },
        model: {
          type: "string",
          description:
            "Model override for the new agent. Omit unless an explicit override is needed.",
        },
        reasoning_effort: {
          type: "string",
          description:
            "Reasoning effort override for the new agent. Omit to inherit the parent effort.",
        },
        task_name: {
          type: "string",
          description:
            "Task name for the new agent. Use lowercase letters, digits, and underscores.",
        },
      },
      additionalProperties: false,
      required: ["task_name", "message"],
    }),
    captureHistory: (args) => forkMode(args) !== "none",
    ...taskReceiptRenderers("spawn_agent", deps.getModelDefaults),
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
      return {
        ...textResult(JSON.stringify(value), { ...result.details, task_name: record.taskName }),
        value,
      };
    },
  });
  const list_agents = defineSubagentTool({
    name: "list_agents",
    label: "list_agents",
    description:
      "List live agents in the current root thread tree. Optionally filter by task-path prefix.",
    parameters: Type.Unsafe<{ path_prefix?: string }>({
      type: "object",
      properties: {
        path_prefix: {
          type: "string",
          description:
            "Task-path prefix filter without a trailing slash. Omit to list all live agents.",
        },
      },
      additionalProperties: false,
    }),
    ...observationReceiptRenderers("list_agents"),
    async execute(_id, args, _signal, _update, ctx) {
      const sessionId = ctx.sessionManager.getSessionId();
      const { rootId } = deps.manager.taskPaths.caller(sessionId);
      const prefix =
        args.path_prefix === undefined
          ? undefined
          : deps.manager.taskPaths.resolve(sessionId, args.path_prefix);
      const records = deps.manager.listAgents();
      const agents = [
        { agent_name: "/root", agent_status: roots.get(rootId) ?? ("running" as const) },
        ...records
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
      const now = Date.now();
      const snapshots: AgentSnapshot[] = agents.map((agent) => {
        const record = records.find(
          (r) => r.rootSessionId === rootId && r.taskName === agent.agent_name,
        );
        return record
          ? snapshotAgent(record, now)
          : {
              path: agent.agent_name,
              status: lifecycleStatusLabel(agent.agent_status, "pending_init"),
            };
      });
      return {
        ...textResult(JSON.stringify(value), { prefix: prefix ?? "/root", agents: snapshots }),
        value,
      };
    },
  });
  const messagingDefinitions = {
    send_message: {
      description:
        "Send a message to an existing agent. The message will be delivered promptly. Does not trigger a new turn.",
      parameters: {
        type: "object",
        properties: {
          message: {
            type: "string",
            description: "Message text to queue on the target agent.",
          },
          target: {
            type: "string",
            description: "Relative or canonical task name to message (from spawn_agent).",
          },
        },
        additionalProperties: false,
        required: ["target", "message"],
      },
    },
    followup_task: {
      description:
        "Send a follow-up task to an existing non-root target agent and trigger a turn if it is idle. If the target is already running, deliver the task promptly at message boundaries while sampling, or after the pending tool call completes.",
      parameters: {
        type: "object",
        properties: {
          message: {
            type: "string",
            description: "Message text to send to the target agent.",
          },
          target: {
            type: "string",
            description:
              "Agent id or canonical task name to send a follow-up task to (from spawn_agent).",
          },
        },
        additionalProperties: false,
        required: ["target", "message"],
      },
    },
  };
  const messaging = (name: "send_message" | "followup_task") =>
    defineSubagentTool({
      name,
      label: name,
      description: messagingDefinitions[name].description,
      parameters: Type.Unsafe<{ target: string; message: string }>(
        messagingDefinitions[name].parameters,
      ),
      ...taskReceiptRenderers(name),
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
        const details: SubagentMessageDetails = {
          sender: {
            id: caller.path,
            type: resolveAgent(ctx.parentRole ?? "default").type,
            title: caller.path,
          },
          message: args.message,
          task: name === "followup_task",
        };
        const accepted = record
          ? await deps.manager.deliverTask(pi, ctx, record.id, details, signal)
          : deps.queueMail(caller.rootId, details);
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
  const interrupt_agent = defineSubagentTool({
    name: "interrupt_agent",
    label: "interrupt_agent",
    description:
      "Interrupt an agent's current turn, if any, and return its previous status. The agent remains available for messages and follow-up tasks.",
    parameters: Type.Unsafe<{ target: string }>({
      type: "object",
      properties: {
        target: {
          type: "string",
          description: "Agent id or canonical task name to interrupt (from spawn_agent).",
        },
      },
      additionalProperties: false,
      required: ["target"],
    }),
    ...observationReceiptRenderers("interrupt_agent"),
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
      return {
        ...textResult(JSON.stringify(value), { target: record.taskName, previousStatus: status }),
        value,
      };
    },
  });
  const wait_agent = defineSubagentTool({
    name: "wait_agent",
    label: "wait_agent",
    description:
      "Wait for a mailbox update from any live agent, including queued messages and final-status notifications. The wait also ends early when new user input is steered into the active turn. Does not return the content; returns either a mailbox-activity summary without agent names, an interruption summary for steered input, or a timeout summary if no activity arrives before the deadline.",
    parameters: Type.Unsafe<{ timeout_ms?: number }>({
      type: "object",
      properties: {
        timeout_ms: {
          type: "integer",
          description: "Timeout in milliseconds. Defaults to 30000, min 10000, max 3600000.",
        },
      },
      additionalProperties: false,
    }),
    ...observationReceiptRenderers("wait_agent"),
    async execute(_id, args, signal, onUpdate, ctx) {
      const requested = args.timeout_ms ?? 30_000;
      if (requested > 3_600_000) throw new Error("timeout_ms must not exceed 3600000");
      const timeout = Math.max(10_000, requested);
      const messenger = deps.getMessenger(ctx.sessionManager.getSessionId());
      if (!messenger) throw new Error("Mailbox is unavailable");
      const { rootId, path } = deps.manager.taskPaths.caller(ctx.sessionManager.getSessionId());
      const startedAt = Date.now();
      const snapshot = (outcome: WaitSnapshot["outcome"]): WaitSnapshot => {
        const now = Date.now();
        const records = deps.manager.listAgents().filter((r) => r.rootSessionId === rootId);
        const children = (parent: string) =>
          records.filter(
            (r): r is AgentRecord & { taskName: string } =>
              r.taskName !== undefined &&
              r.taskName.startsWith(`${parent}/`) &&
              !r.taskName.slice(parent.length + 1).includes("/"),
          );
        return {
          outcome,
          elapsedMs: Math.max(0, now - startedAt),
          requestedMs: requested,
          timeoutMs: timeout,
          agents: children(path)
            .sort((a, b) => a.taskName.localeCompare(b.taskName))
            .map((record) => {
              const descendants = children(record.taskName);
              return {
                ...snapshotAgent(record, now),
                toolCalls: [...record.toolCalls],
                children: descendants.length,
                runningChildren: descendants.filter((r) => r.status === "running").length,
              };
            }),
        };
      };
      const update = () => onUpdate?.(textResult("", { wait: snapshot("waiting") }));
      update();
      // Execution owns the clock; saved rows never start timers or look up live children.
      const timer = onUpdate ? setInterval(update, 1000) : undefined;
      try {
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
        return {
          ...textResult(JSON.stringify(value), {
            wait: snapshot(outcome === "mail" ? "completed" : outcome),
          }),
          value,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new SubagentOperationError(message, {
          wait: snapshot(signal?.aborted || message === "Wait cancelled." ? "cancelled" : "failed"),
        });
      } finally {
        clearInterval(timer);
      }
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
