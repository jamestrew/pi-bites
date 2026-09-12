import type { ExtensionAPI, AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { contract, execDescription } from "./contracts.js";
import { unsignedInteger } from "./exec-source.js";
import type { CodeModeLifecycle } from "./lifecycle.js";
import type { NestedToolBridge } from "./nested-tools.js";
import { codeModeResult, type CodeModeDetails } from "./results.js";
import { createCodeModeRendering } from "./rendering.js";
import type { OwnedNestedTools } from "./nested-tools.js";
import type { NestedTraces } from "./nested-traces.js";
import type { RuntimeResponse, RuntimeTool } from "./types.js";

export function registerCodeModeTools(
  pi: ExtensionAPI,
  lifecycle: CodeModeLifecycle,
  bridge: NestedToolBridge,
  getTools: () => RuntimeTool[],
  owned: OwnedNestedTools,
) {
  const rendering = createCodeModeRendering(owned);
  pi.on("session_start", () => rendering.reset());
  pi.on("session_tree", () => rendering.reset());
  const exec = {
    ...rendering.forTool("exec"),
    name: "exec",
    label: "exec",
    description: execDescription([], false),
    parameters: Type.Object({ code: Type.String() }, { additionalProperties: false }),
    constrainedSampling: {
      type: "grammar" as const,
      variants: { openai_lark: contract.exec_grammar },
    },
    async execute(
      _id: string,
      params: { code: string },
      signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback<CodeModeDetails>,
    ) {
      const runtime = lifecycle.current();
      const tools = getTools();
      const observation = observeCodeMode(bridge.traces, onUpdate);
      try {
        const response = await runtime.execute(params.code, signal, tools, observation.start);
        return observation.result(response, response.maxOutputTokens ?? 10_000);
      } catch (error) {
        return observation.failure(error, 10_000);
      } finally {
        observation.dispose();
      }
    },
  };
  const wait = {
    ...rendering.forTool("wait"),
    name: "wait",
    label: "wait",
    description: contract.wait_description,
    parameters: Type.Object(
      {
        cell_id: Type.String(contract.wait_schema.properties.cell_id),
        yield_time_ms: Type.Optional(Type.Number(contract.wait_schema.properties.yield_time_ms)),
        max_tokens: Type.Optional(Type.Number(contract.wait_schema.properties.max_tokens)),
        terminate: Type.Optional(Type.Boolean(contract.wait_schema.properties.terminate)),
      },
      { additionalProperties: false },
    ),
    async execute(
      _id: string,
      params: { cell_id: string; yield_time_ms?: number; max_tokens?: number; terminate?: boolean },
      signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback<CodeModeDetails>,
    ) {
      const maxTokens = unsignedInteger(params.max_tokens ?? 10_000, "max_tokens");
      const delay = unsignedInteger(params.yield_time_ms ?? 10_000, "yield_time_ms");
      signal?.throwIfAborted();
      const runtime = lifecycle.current();
      const observation = observeCodeMode(bridge.traces, onUpdate);
      const onStarted = () => {
        observation.start(params.cell_id);
        observation.publish();
      };
      try {
        const response = params.terminate
          ? await runtime.terminate(params.cell_id, onStarted)
          : await runtime.wait(params.cell_id, delay, signal, onStarted);
        return observation.result(response, maxTokens);
      } catch (error) {
        return observation.failure(error, maxTokens);
      } finally {
        observation.dispose();
      }
    },
  };
  pi.registerTool(exec);
  pi.registerTool(wait);
  pi.on("tool_result", (event) => {
    if (event.toolName !== "exec" && event.toolName !== "wait") return;
    const details = event.details as CodeModeDetails | undefined;
    if (details?.codeMode && details.failed) return { isError: true };
  });
  let description = exec.description;
  return (names: string[], grammar: boolean) => {
    const next = execDescription(names, grammar);
    if (next === description) return;
    description = next;
    pi.registerTool({ ...exec, description });
  };
}

/** One observation owns the UI subscription and its saved version, never a Pi ctx. */
function observeCodeMode(
  traces: NestedTraces,
  onUpdate?: AgentToolUpdateCallback<CodeModeDetails>,
) {
  const startedAt = performance.now();
  let subscription: ReturnType<NestedTraces["observe"]> | undefined;
  let cellId: string | undefined;
  const publish = () => {
    if (!cellId || !subscription) return;
    onUpdate?.({
      content: [],
      details: {
        codeMode: true,
        cellId,
        state: "yielded",
        failed: false,
        traces: traces.forCell(cellId),
        displayVersion: subscription.version,
      },
    });
  };
  return {
    start: (id: string) => {
      cellId = id;
      subscription = traces.observe(id, publish);
    },
    publish,
    result: (response: RuntimeResponse, maxTokens: number) =>
      codeModeResult(
        response,
        performance.now() - startedAt,
        maxTokens,
        subscription ? traces.forCell(response.cellId) : [],
        subscription?.version,
      ),
    failure: (error: unknown, maxTokens: number) => {
      if (!cellId || !subscription) throw error;
      const interrupted = traces.forCell(cellId).map((trace) => {
        if (trace.state === "completed" || trace.state === "error") return trace;
        const partialOutput = (trace.result?.details as { output?: unknown } | undefined)?.output;
        return {
          ...trace,
          state: "error" as const,
          result: {
            content: [
              {
                type: "text" as const,
                text: `${typeof partialOutput === "string" && partialOutput ? `${partialOutput}\n\n` : ""}Execution interrupted`,
              },
            ],
            details: trace.name === "apply_patch" ? trace.result?.details : undefined,
          },
        };
      });
      return codeModeResult(
        {
          kind: "result",
          cellId,
          contentItems: [],
          errorText: error instanceof Error ? error.message : String(error),
        },
        performance.now() - startedAt,
        maxTokens,
        interrupted,
        subscription.version,
      );
    },
    dispose: () => subscription?.dispose(),
  };
}
