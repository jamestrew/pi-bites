import type { ExtensionContext, AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { BashGateController, CommandAuthorizationSession } from "../../bash-gate/index.js";
import type { CodexAdapterConfig } from "../../config.js";
import type { ToolExecutionContext } from "../tool-execution.js";
import type { DelegateCall, RuntimeTool } from "./types.js";
import { NestedTraces, type NestedTrace } from "./nested-traces.js";
import {
  createNestedAdapters,
  type NestedAdapter,
  type OwnedNestedTools,
} from "./nested-adapters.js";
export type { OwnedNestedTools } from "./nested-adapters.js";

interface Snapshot {
  context: ToolExecutionContext;
  authorization: CommandAuthorizationSession;
  signal: AbortSignal;
}

/** Internal dispatcher for #300. Capture on lifecycle/turn events, never in a delegate callback.
 * Invalidating the owning runtime cancels cells; clear also drops navigation/trace state.
 */
export class NestedToolBridge {
  readonly traces = new NestedTraces();
  private snapshot: Snapshot | undefined;
  private enabled: ReadonlySet<string> | undefined;

  setEnabled(names: ReadonlySet<string>): void {
    this.enabled = new Set(names);
  }
  private owner = new AbortController();
  private readonly adapters: NestedAdapter[];

  constructor(
    private readonly owned: OwnedNestedTools,
    private readonly gate: BashGateController | undefined,
    getConfig: () => CodexAdapterConfig,
  ) {
    this.adapters = createNestedAdapters(owned, getConfig);
  }

  capture(ctx: ExtensionContext): void {
    const trusted = ctx.isProjectTrusted();
    const context: ToolExecutionContext = {
      cwd: ctx.cwd,
      model: ctx.model,
      modelRegistry: ctx.modelRegistry,
      isProjectTrusted: () => trusted,
    };
    this.snapshot = {
      context,
      authorization: this.gate?.captureSession(ctx) ?? {
        async authorize(request, launch) {
          request.signal?.throwIfAborted();
          return launch();
        },
      },
      signal: ctx.signal ?? new AbortController().signal,
    };
  }

  clear(): void {
    this.owner.abort(new Error("Code Mode tool session was cleared"));
    this.owner = new AbortController();
    this.snapshot = undefined;
    this.traces.clear();
    this.owned.web_run.resetNavigationState();
  }

  tools(): RuntimeTool[] {
    const snapshot = this.current();
    const owner = this.owner.signal;
    return this.adapters
      .filter(
        (adapter) =>
          (!this.enabled || this.enabled.has(adapter.name)) && adapter.available(snapshot.context),
      )
      .map((adapter) => ({
        name: adapter.name,
        description: adapter.description,
        kind: adapter.kind,
        inputSchema: adapter.inputSchema,
        invoke: (input, call) => this.invoke(adapter, input, call, owner),
      }));
  }

  private current(): Snapshot {
    if (!this.snapshot) throw new Error("Code Mode tool session is unavailable");
    this.snapshot.signal.throwIfAborted();
    return this.snapshot;
  }

  private async invoke(
    adapter: NestedAdapter,
    input: unknown,
    call: DelegateCall,
    owner: AbortSignal,
  ): Promise<unknown> {
    owner.throwIfAborted();
    const snapshot = this.current();
    const signal = AbortSignal.any([owner, snapshot.signal, call.signal]);
    let params = input;
    const trace = (state: NestedTrace["state"], result?: AgentToolResult<unknown>) => {
      if (!owner.aborted)
        this.traces.record({
          cellId: call.cellId,
          callId: call.callId,
          cwd: snapshot.context.cwd,
          name: adapter.name,
          input: params,
          result,
          state,
        });
    };
    trace("running");
    try {
      signal.throwIfAborted();
      if ((this.enabled && !this.enabled.has(adapter.name)) || !adapter.available(snapshot.context))
        throw new Error(`${adapter.name} is unavailable for the active model`);
      const result = await adapter.invoke(input, {
        call,
        signal,
        context: snapshot.context,
        authorization: snapshot.authorization,
        prepared: (value) => {
          params = value;
          trace("running");
        },
        status: (state) => trace(state),
        update: (value) => trace("running", value),
      });
      signal.throwIfAborted();
      trace(result.isError ? "error" : "completed", result.result);
      if (result.reject) throw new NestedResultError(result.result);
      return result.value;
    } catch (error) {
      if (!(error instanceof NestedResultError))
        trace("error", {
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
          details: adapter.renderDetails?.(call.callId),
        });
      throw error;
    } finally {
      adapter.cleanup?.(call.callId);
    }
  }
}
class NestedResultError extends Error {
  constructor(result: AgentToolResult<unknown>) {
    super(
      result.content
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("\n"),
    );
  }
}
