import type { AdapterModel } from "../activation.js";
import type { RuntimeTool } from "./types.js";
import generated from "./contract.generated.json" with { type: "json" };

export const contract = generated;

export function usesGrammar(model: (AdapterModel & { compat?: object }) | undefined): boolean {
  return (
    model?.compat !== undefined &&
    "supportsOpenAIGrammarTools" in model.compat &&
    model.compat.supportsOpenAIGrammarTools === true &&
    [
      "openai-responses",
      "openai-codex-responses",
      "azure-openai-responses",
      "openai-completions",
    ].includes(model.api ?? "")
  );
}

export function execDescription(names: readonly string[], grammar: boolean): string {
  let base = grammar
    ? generated.exec_base
    : generated.exec_base.replace(
        "Accepts raw JavaScript source text, not JSON, quoted strings, or markdown code fences.",
        "Put JavaScript source text in the required `code` string property. Do not include markdown code fences. The first-line pragma belongs inside that string.",
      );
  if (!names.includes("exec_command"))
    base = base.replace(", for example `await tools.exec_command(...)`", "");
  return [
    base,
    ...generated.tools.filter((tool) => names.includes(tool.name)).map((tool) => tool.section),
  ].join("\n\n");
}

export function nativeTools(tools: RuntimeTool[]): RuntimeTool[] {
  return tools.map((tool) => {
    const definition = generated.tools.find((candidate) => candidate.name === tool.name);
    if (!definition) throw new Error(`Missing native Code Mode contract: ${tool.name}`);
    return {
      ...tool,
      description: definition.description,
      inputSchema: definition.input_schema ?? undefined,
      outputSchema: definition.output_schema ?? undefined,
    };
  });
}
