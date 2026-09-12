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
    ...(names.includes("web_run") ? [webDiscoveryGuidance] : []),
    ...generated.tools
      .filter((tool) => tool.name !== "web_run" && names.includes(tool.name))
      .map((tool) => tool.section),
  ].join("\n\n");
}

export function nativeTools(tools: RuntimeTool[]): RuntimeTool[] {
  return tools.map((tool) => {
    const definition = generated.tools.find((candidate) => candidate.name === tool.name);
    if (!definition) throw new Error(`Missing native Code Mode contract: ${tool.name}`);
    return {
      ...tool,
      description: definition.runtime_description,
      inputSchema: definition.input_schema ?? undefined,
      outputSchema: definition.output_schema ?? undefined,
    };
  });
}

// Exposure policy only: the complete retained native contract is returned by ALL_TOOLS.
const webDiscoveryGuidance = `web_run can search the internet, search images, and open, click, or find text in web pages. Before using it, retrieve and read its complete documentation (including citation and word-limit instructions) in a separate exec call:
text(ALL_TOOLS.filter((tool) => tool.name === "web_run"));
Retrieve it again if that documentation is no longer in context. Discovery does not execute a web request or grant permission.
Browse when explicitly asked to search, browse, verify, or look something up; obey explicit requests not to browse. Also browse for information that could have changed (including news, prices, laws, schedules, product specifications, public figures, software, and recommendations); substantial time or money recommendations; precise quotes, links, or attribution; referenced pages or papers whose contents were not supplied; uncertain, niche, or emerging facts; and high-stakes medical, legal, or financial accuracy. When unsure whether browsing is needed, browse. Check local code first for OpenAI product questions; if browsing is needed, use official OpenAI sources unless requested otherwise. Read the full contract before actual web use.`;
