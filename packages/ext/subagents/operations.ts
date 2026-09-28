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
import { CODEX_V1_CONTRACT } from "./codex-v1-contract.js";
import { captureSubagentContext } from "./operation-context.js";
import type { createAgentTool } from "./register-agent-tool.js";
import type { createSendInput } from "./register-send-input.js";
import type { createWaitAgent } from "./register-wait-agent.js";
import type { createCloseAgent } from "./register-close-agent.js";
import type { createResumeAgent } from "./register-resume-agent.js";

export interface V1SubagentTools {
  spawn_agent: ReturnType<typeof createAgentTool>;
  send_input: ReturnType<typeof createSendInput>;
  wait_agent: ReturnType<typeof createWaitAgent>;
  close_agent: ReturnType<typeof createCloseAgent>;
  resume_agent: ReturnType<typeof createResumeAgent>;
}
type V2SubagentTools = ReturnType<typeof createV2Tools>;
export type SubagentTools = V1SubagentTools | V2SubagentTools;
export type SubagentOperation = keyof V1SubagentTools | keyof V2SubagentTools;
type OwnedTool = V1SubagentTools[keyof V1SubagentTools] | V2SubagentTools[keyof V2SubagentTools];
type Result = Awaited<ReturnType<OwnedTool["execute"]>>;
export interface SubagentCall {
  /** Parent conversation identity, not a cell or shell id. */
  callerId: string;
  callId: string;
  signal?: AbortSignal;
  onUpdate?: (result: { content: Result["content"]; details: unknown }) => void;
}

export interface SubagentRegistration {
  directOnly: boolean;
  childPrompt?: (record: AgentRecord) => string;
}

const V1_REGISTRATION: SubagentRegistration = {
  directOnly: false,
  childPrompt: (record) =>
    "\nYour parent agent id is " +
    record.parentSessionId +
    ". Use send_input (tools.multi_agent_v1__send_input inside Code Mode) with this target for substantive parent messages, when available. Delivery waits for the next model boundary; still return a final response.",
};

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
    private registration: SubagentRegistration = V1_REGISTRATION,
  ) {}

  /** The staged named-task tools stay direct, including inside Code Mode. */
  get directOnly(): boolean {
    return this.registration.directOnly;
  }

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
      const params = args as Record<string, unknown>;
      if (this.tool(name).captureHistory?.(args) && !forkContext)
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
      this.registration,
    );
  }

  registerTools(): void {
    const childPrompt = this.child && this.registration.childPrompt?.(this.child);
    if (childPrompt) {
      this.pi.on("before_agent_start", (event) => ({
        systemPrompt: event.systemPrompt + childPrompt,
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

  renderers(name: SubagentOperation) {
    const { renderCall, renderResult } = this.tool(name);
    return { renderCall, renderResult };
  }

  /** Pinned declaration metadata is not executor discovery. */
  readonly definitions = CODEX_V1_CONTRACT.tools;
}
