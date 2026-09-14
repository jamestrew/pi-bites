import type { AgentRecord } from "./types.js";
import type { TSchema } from "typebox";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import type { AgentManager } from "./agent-manager.js";
import { CODEX_V1_CONTRACT } from "./codex-v1-contract.js";
import { captureSubagentContext } from "./operation-context.js";
import type { createAgentTool } from "./register-agent-tool.js";
import type { createSendInput } from "./register-send-input.js";
import type { createWaitAgent } from "./register-wait-agent.js";
import type { createCloseAgent } from "./register-close-agent.js";
import type { createResumeAgent } from "./register-resume-agent.js";

export interface SubagentTools {
  spawn_agent: ReturnType<typeof createAgentTool>;
  send_input: ReturnType<typeof createSendInput>;
  wait_agent: ReturnType<typeof createWaitAgent>;
  close_agent: ReturnType<typeof createCloseAgent>;
  resume_agent: ReturnType<typeof createResumeAgent>;
}
export type SubagentOperation = keyof SubagentTools;
type Result = Awaited<ReturnType<SubagentTools[SubagentOperation]["execute"]>>;
export interface SubagentCall {
  /** Parent conversation identity, not a cell or shell id. */
  callerId: string;
  callId: string;
  signal?: AbortSignal;
  onUpdate?: (result: { content: Result["content"]; details: unknown }) => void;
}

/** Session-owned execution, independent of direct/nested exposure and Pi tool events. */
export class SubagentController {
  private owner = new AbortController();
  private activeCalls = new Set<string>();

  constructor(
    private pi: ExtensionAPI,
    private tools: SubagentTools,
    private manager: AgentManager,
    private isScopeModelsEnabled: () => boolean,
    private getAllowedTools: () => string[],
    private child?: AgentRecord,
  ) {}

  invalidate(): void {
    this.owner.abort(new Error("Subagent owner changed"));
    this.owner = new AbortController();
    this.activeCalls = new Set();
  }

  /** Call while ctx is active. Only requested fork history crosses the async boundary. */
  capture(ctx: ExtensionContext, options: { forkContext?: boolean } = {}) {
    const owner = this.owner.signal;
    owner.throwIfAborted();
    const forkContext = options.forkContext === true;
    const snapshot = captureSubagentContext(this.pi, ctx, forkContext, this.getAllowedTools());
    snapshot.callerAgentId = this.child?.id;
    snapshot.parentRole = this.child?.type ?? snapshot.parentRole;
    snapshot.scopeModels = this.isScopeModelsEnabled();
    const callerId = snapshot.sessionManager.getSessionId();
    const activeCalls = this.activeCalls;
    const execute = async (
      name: SubagentOperation,
      args: unknown,
      call: SubagentCall,
    ): Promise<Result> => {
      const signal = AbortSignal.any([
        owner,
        ...[snapshot.signal, call.signal].filter((s): s is AbortSignal => !!s),
      ]);
      signal.throwIfAborted();
      if (
        this.child &&
        (this.manager.getRecord(this.child.id) !== this.child ||
          this.manager.isClosing(this.child.id))
      )
        throw new Error("Subagent owner is closed");
      if (callerId !== call.callerId) throw new Error("Subagent caller does not own this session");
      if (!call.callId.trim() || activeCalls.has(call.callId))
        throw new Error("Subagent call id must be unique and nonempty");
      if (!Object.hasOwn(this.tools, name) || !snapshot.allowedTools?.includes(name))
        throw new Error(`Subagent operation ${name} is unavailable`);
      const tool = this.tools[name];
      if (!Check(tool.parameters, args)) throw new Error(`Invalid arguments for ${name}`);
      const params = args as Record<string, unknown>;
      if (params.fork_context && !forkContext)
        throw new Error("Fork history was not captured for this call");
      const targets =
        name === "wait_agent"
          ? (params.targets as string[])
          : [params.target ?? params.id].filter((id): id is string => typeof id === "string");
      for (const id of targets) {
        if (this.child && name === "close_agent" && this.manager.tree.containsSession(id, callerId))
          throw new Error("Cannot close the calling agent or its ancestors from its own tool call");
        const record = this.manager.getRecord(id) ?? this.manager.getClosedRecord(id);
        if (
          record &&
          "parentSessionId" in record &&
          (record.rootSessionId ?? record.parentSessionId) !==
            (this.child?.rootSessionId ?? this.child?.parentSessionId ?? callerId)
        )
          throw new Error(`agent with id ${id} is not owned by this session`);
      }
      activeCalls.add(call.callId);
      try {
        // Validation narrows this heterogeneous owned-tool union. No metadata discovery or host events.
        return await tool.execute(
          call.callId,
          args as never,
          signal,
          call.onUpdate
            ? (update) => {
                if (signal.aborted) return;
                try {
                  call.onUpdate?.(update);
                } catch {
                  /* A lost display channel does not own the operation. */
                }
              }
            : undefined,
          snapshot,
        );
      } finally {
        activeCalls.delete(call.callId);
      }
    };
    const capabilities = Object.keys(this.tools).filter((name) =>
      snapshot.allowedTools?.includes(name),
    );
    return { callerId, model: snapshot.model, capabilities, execute };
  }

  forChild(
    pi: ExtensionAPI,
    record: AgentRecord,
    getAllowedTools: () => string[],
  ): SubagentController {
    return new SubagentController(
      pi,
      this.tools,
      this.manager,
      this.isScopeModelsEnabled,
      getAllowedTools,
      record,
    );
  }

  registerTools(): void {
    if (this.child) {
      const parentId = this.child.parentSessionId;
      this.pi.on("before_agent_start", (event) => ({
        systemPrompt:
          event.systemPrompt +
          "\nYour parent agent id is " +
          parentId +
          ". Use send_input with this target for substantive parent messages. Delivery waits for the next model boundary; still return a final response.",
      }));
    }
    for (const name of Object.keys(this.tools) as SubagentOperation[]) {
      const tool = this.tools[name] as ToolDefinition<TSchema, unknown>;
      this.pi.registerTool<TSchema, unknown>({
        ...tool,
        execute: (callId, args, signal, onUpdate, ctx) => {
          const operation = this.capture(ctx, {
            forkContext:
              typeof args === "object" &&
              args !== null &&
              "fork_context" in args &&
              args.fork_context === true,
          });
          return operation.execute(name, args, {
            callerId: operation.callerId,
            callId,
            signal,
            onUpdate,
          });
        },
      });
    }
  }

  renderers(name: SubagentOperation) {
    const { renderCall, renderResult } = this.tools[name];
    return { renderCall, renderResult };
  }

  /** Pinned declaration metadata is not executor discovery. */
  readonly definitions = CODEX_V1_CONTRACT.tools;
}
