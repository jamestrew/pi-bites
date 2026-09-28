import type { createV2Tools } from "./v2-tools.js";
import type { AgentRecord } from "./types.js";
import type { TSchema } from "typebox";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import type { AgentManager } from "./agent-manager.js";
import { captureSubagentContext } from "./operation-context.js";
export type SubagentTools = ReturnType<typeof createV2Tools>;
export type SubagentOperation = keyof SubagentTools;
type OwnedTool = SubagentTools[SubagentOperation];
type Result = Awaited<ReturnType<OwnedTool["execute"]>>;
export interface SubagentCall {
  /** Parent conversation identity, not a cell or shell id. */
  callerId: string;
  callId: string;
  signal?: AbortSignal;
  onUpdate?: (result: { content: Result["content"]; details: unknown }) => void;
}

/** Session-owned direct execution, independent of provider and model selection. */
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

  private tool(name: SubagentOperation): OwnedTool {
    const tool = (this.tools as Partial<Record<SubagentOperation, OwnedTool>>)[name];
    if (!tool) throw new Error(`Subagent operation ${name} is unavailable`);
    return tool;
  }

  invalidate(): void {
    this.owner.abort(new Error("Subagent owner changed"));
    this.owner = new AbortController();
    this.activeCalls = new Set();
  }

  /** Call while ctx is active. Only requested fork history crosses the async boundary. */
  capture(ctx: ExtensionContext, options: { forkContext?: boolean } = {}) {
    const owner = this.owner.signal;
    owner.throwIfAborted();
    const forkContext = options.forkContext ?? this.tools.spawn_agent.captureHistory?.({}) ?? false;
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
      const tool = this.tool(name);
      if (!Check(tool.parameters, args)) throw new Error(`Invalid arguments for ${name}`);
      if (tool.captureHistory?.(args) && !forkContext)
        throw new Error("Fork history was not captured for this call");
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
      const path = this.child.taskName;
      if (!path) throw new Error("Named agent has no task path");
      const parentPath = path.slice(0, path.lastIndexOf("/"));
      this.pi.on("before_agent_start", (event) => ({
        systemPrompt:
          event.systemPrompt +
          `\nYour canonical task_name is ${path}. Relative task paths resolve beneath your path; /root is the root agent. Your parent task_name is ${parentPath}. Use send_message with that target for substantive parent messages, when permitted. Messages queue without starting idle work; followup_task assigns work to an existing non-root agent. Delivery occurs at Pi model boundaries; still return a final response.`,
      }));
    }
    for (const name of Object.keys(this.tools) as SubagentOperation[]) {
      const tool = this.tool(name) as ToolDefinition<TSchema, unknown>;
      this.pi.registerTool<TSchema, unknown>({
        ...tool,
        execute: async (callId, args, signal, onUpdate, ctx) => {
          const operation = this.capture(ctx, {
            forkContext: this.tool(name).captureHistory?.(args),
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
}
