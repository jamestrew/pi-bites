import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import type { Static, TSchema, TObject } from "typebox";
import type { CommandAuthorizationSession } from "../../bash-gate/index.js";
import type { CodexAdapterConfig } from "../../config.js";
import type { OwnedToolDefinition, ToolExecutionContext } from "../tool-execution.js";
import { type createApplyPatchTool, isApplyPatchFailure } from "../apply-patch/tool.js";
import {
  getApplyPatchRenderSnapshot,
  deleteApplyPatchRenderState,
} from "../apply-patch/render-state.js";
import { ExecCommandError, type createExecCommandTool } from "../exec/command-tool.js";
import type { UnifiedExecResult } from "../exec/session-manager.js";
import type { createWriteStdinTool } from "../exec/write-stdin-tool.js";
import { isWebRunAvailable, type createWebRunTool } from "../web-run/tool.js";
import type { createViewImageTool } from "../view-image/tool.js";
import { getBundledViewImagePath } from "../view-image/binary.js";
import type { DelegateCall, RuntimeTool } from "./types.js";

/** These definitions are shared with direct registration; no replacement executors. */
export interface OwnedNestedTools {
  exec_command: ReturnType<typeof createExecCommandTool>;
  write_stdin: ReturnType<typeof createWriteStdinTool>;
  apply_patch: ReturnType<typeof createApplyPatchTool>;
  web_run: ReturnType<typeof createWebRunTool>;
  view_image: ReturnType<typeof createViewImageTool>;
}
interface Invocation {
  call: DelegateCall;
  signal: AbortSignal;
  context: ToolExecutionContext;
  authorization: CommandAuthorizationSession;
  prepared(params: unknown): void;
  status(this: void, state: "approval" | "running"): void;
  update(result: AgentToolResult<unknown>): void;
}
export interface NestedResult {
  value: unknown;
  result: AgentToolResult<unknown>;
  isError: boolean;
  reject: boolean;
}
export interface NestedAdapter extends Pick<
  RuntimeTool,
  "name" | "kind" | "description" | "inputSchema"
> {
  available(context: ToolExecutionContext): boolean;
  invoke(input: unknown, invocation: Invocation): Promise<NestedResult>;
  renderDetails?(this: void, callId: string): unknown;
  cleanup?(this: void, callId: string): void;
}
interface Policy<P extends TObject, D> {
  freeform?: boolean;
  omit?: string[];
  input?(input: unknown): unknown;
  available?(this: void, context: ToolExecutionContext): boolean;
  execute?(
    params: Static<P>,
    invocation: Invocation,
    run: () => Promise<AgentToolResult<D>>,
  ): Promise<AgentToolResult<D>>;
  observe?(result: AgentToolResult<D>, call: DelegateCall): void;
  project(result: AgentToolResult<D>): unknown;
  isError?(result: AgentToolResult<D>): boolean;
  reject?(result: AgentToolResult<D>): boolean;
  renderDetails?(this: void, callId: string): unknown;
  cleanup?(this: void, callId: string): void;
}

/** Bind once while the concrete parameter/result types are known. Only the validated boundary
 * accepts unknown; policies and executors retain their actual types throughout dispatch.
 */
function bind<P extends TObject, D, S>(
  tool: OwnedToolDefinition<P, D, S>,
  policy: Policy<P, D>,
): NestedAdapter {
  const properties = { ...tool.parameters.properties };
  for (const name of policy.omit ?? []) delete properties[name];
  const schema: P = { ...tool.parameters, properties, additionalProperties: false };
  return {
    name: tool.name,
    description: tool.description,
    kind: policy.freeform ? "freeform" : "function",
    ...(policy.freeform ? {} : { inputSchema: schema }),
    available: policy.available ?? (() => true),
    renderDetails: policy.renderDetails,
    cleanup: policy.cleanup,
    async invoke(input, invocation) {
      const raw = policy.input ? policy.input(input) : input;
      validate(schema, raw);
      const params: unknown = tool.prepareArguments ? tool.prepareArguments(raw) : raw;
      validate(schema, params);
      invocation.signal.throwIfAborted();
      invocation.prepared(params);
      const observe = (result: AgentToolResult<D>) => policy.observe?.(result, invocation.call);
      const run = () => {
        invocation.signal.throwIfAborted();
        invocation.status("running");
        const pending = tool.execute(
          invocation.call.callId,
          params,
          invocation.signal,
          (result) => {
            observe(result);
            invocation.update(result);
          },
          invocation.context,
        );
        const details = policy.renderDetails?.(invocation.call.callId);
        if (details) invocation.update({ content: [], details });
        return pending;
      };
      const result = await (policy.execute ? policy.execute(params, invocation, run) : run());
      invocation.signal.throwIfAborted();
      observe(result);
      return {
        value: policy.project(result),
        result,
        isError: policy.isError?.(result) ?? false,
        reject: policy.reject?.(result) ?? false,
      };
    },
  };
}

async function shellResult(
  run: () => Promise<AgentToolResult<UnifiedExecResult>>,
): Promise<AgentToolResult<UnifiedExecResult>> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof ExecCommandError)) throw error;
    return { content: [{ type: "text", text: error.message }], details: error.result };
  }
}
const shellFailed = (result: AgentToolResult<UnifiedExecResult>) =>
  result.details.exit_code !== undefined && result.details.exit_code !== 0;

export function createNestedAdapters(
  owned: OwnedNestedTools,
  getConfig: () => CodexAdapterConfig,
): NestedAdapter[] {
  return [
    bind(owned.exec_command, {
      execute: async (params, { authorization, call, signal, status }, run) => {
        status("approval");
        return await authorization.authorize(
          { toolCallId: call.callId, toolName: "exec_command", command: params.cmd, signal },
          () => shellResult(run),
        );
      },
      observe: (result, call) => {
        if (result.details.session_id !== undefined) call.ownShell(result.details.session_id);
      },
      project: (result) => result.details,
      isError: shellFailed,
    }),
    bind(owned.write_stdin, {
      execute: (_params, _invocation, run) => shellResult(run),
      project: (result) => result.details,
      isError: shellFailed,
    }),
    bind(owned.apply_patch, {
      freeform: true,
      input: (input) => {
        if (typeof input !== "string")
          throw new Error("apply_patch requires a freeform patch string");
        return { input };
      },
      project: () => ({}),
      isError: (result) => isApplyPatchFailure(result.details),
      reject: (result) => isApplyPatchFailure(result.details),
      renderDetails: (callId) => ({ render: getApplyPatchRenderSnapshot(callId) }),
      cleanup: deleteApplyPatchRenderState,
    }),
    bind(owned.web_run, {
      omit: ["settings"],
      available: (context) => isWebRunAvailable(context.model, getConfig()),
      project: (result) =>
        result.content
          .filter((item) => item.type === "text")
          .map((item) => item.text)
          .join("\n"),
    }),
    bind(owned.view_image, {
      available: (context) =>
        context.model?.input.includes("image") === true && !!getBundledViewImagePath(),
      project: (result) => {
        const image = result.content.find((item) => item.type === "image");
        if (!image) throw new Error("view_image returned no image");
        return { image_url: `data:${image.mimeType};base64,${image.data}`, detail: "original" };
      },
    }),
  ];
}

function validate<P extends TSchema>(schema: P, input: unknown): asserts input is Static<P> {
  if (!Value.Check(schema, input))
    throw new Error(
      `Invalid nested tool arguments: ${[...Value.Errors(schema, input)].map((error) => `${error.instancePath} ${error.message}`).join("; ")}`,
    );
  const checkNumbers = (value: unknown): void => {
    if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0))
      throw new Error("Nested numeric arguments must be nonnegative safe integers");
    if (value && typeof value === "object")
      for (const item of Object.values(value)) checkNumbers(item);
  };
  checkNumbers(input);
}
