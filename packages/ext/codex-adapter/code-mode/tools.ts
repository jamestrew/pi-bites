import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { contract, execDescription } from "./contracts.js";
import { unsignedInteger } from "./exec-source.js";
import type { CodeModeLifecycle } from "./lifecycle.js";
import type { NestedToolBridge } from "./nested-tools.js";
import { codeModeResult, type CodeModeDetails } from "./results.js";
import type { RuntimeTool } from "./types.js";

export function registerCodeModeTools(
  pi: ExtensionAPI,
  lifecycle: CodeModeLifecycle,
  bridge: NestedToolBridge,
  getTools: () => RuntimeTool[],
) {
  const exec = {
    name: "exec",
    label: "exec",
    description: execDescription([], false),
    parameters: Type.Object({ code: Type.String() }, { additionalProperties: false }),
    constrainedSampling: {
      type: "grammar" as const,
      variants: { openai_lark: contract.exec_grammar },
    },
    async execute(_id: string, params: { code: string }, signal?: AbortSignal) {
      const runtime = lifecycle.current();
      const tools = getTools();
      const start = performance.now();
      const response = await runtime.execute(params.code, signal, tools);
      return codeModeResult(
        response,
        performance.now() - start,
        response.maxOutputTokens ?? 10_000,
        bridge.traces.forCell(response.cellId),
      );
    },
  };
  const wait = {
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
    ) {
      const maxTokens = unsignedInteger(params.max_tokens ?? 10_000, "max_tokens");
      const delay = unsignedInteger(params.yield_time_ms ?? 10_000, "yield_time_ms");
      signal?.throwIfAborted();
      const runtime = lifecycle.current();
      const start = performance.now();
      const response = params.terminate
        ? await runtime.terminate(params.cell_id)
        : await runtime.wait(params.cell_id, delay, signal);
      return codeModeResult(
        response,
        performance.now() - start,
        maxTokens,
        bridge.traces.forCell(response.cellId),
      );
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
