import { CODEX_V1_NESTED_TOOLS } from "../../subagents/codex-v1-contract.js";
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
    ...(names.some((name) => name.startsWith("multi_agent_v1__"))
      ? [subagentDiscoveryGuidance]
      : []),
    ...generated.tools
      .filter((tool) => tool.name !== "web_run" && names.includes(tool.name))
      .map((tool) => tool.section),
  ].join("\n\n");
}

export function nativeTools(tools: RuntimeTool[]): RuntimeTool[] {
  return tools.map((tool) => {
    const definition = [...generated.tools, ...CODEX_V1_NESTED_TOOLS].find(
      (candidate) => candidate.name === tool.name,
    );
    if (!definition) throw new Error(`Missing native Code Mode contract: ${tool.name}`);
    return {
      ...tool,
      toolName: {
        name: definition.tool_name.name,
        ...(definition.tool_name.namespace ? { namespace: definition.tool_name.namespace } : {}),
      },
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

const subagentDiscoveryGuidance = `V1 collaboration is available through tools.multi_agent_v1__spawn_agent, send_input, wait_agent, close_agent, and resume_agent (all use the multi_agent_v1__ prefix), subject to selected capabilities.
Do not spawn sub-agents unless the user or applicable AGENTS.md/skill instructions explicitly ask for sub-agents, delegation, or parallel agent work. Requests for depth, thoroughness, research, investigation, or detailed codebase analysis do not count as permission to spawn. Role guidance never authorizes spawning. When authorized, delegate bounded independent work with a concrete benefit; keep the immediate critical-path task local. Give agents bounded, self-contained assignments and avoid duplicating delegated work. Wait only when their results block progress; a wait timeout does not cancel an agent. Verify delegated changes before reporting completion.
Before using collaboration, retrieve and read the complete generated input/return declarations in a separate exec call:
text(ALL_TOOLS.filter((tool) => tool.name.startsWith("multi_agent_v1__")));
Rediscover when those declarations leave context, including after compaction. Discovery does not start agents, enable tools, or grant permissions. Each child inherits permitted capabilities and chooses its own model's tool surface.
Completed open agents retain capacity until close_agent. Selected-target waits and automatic final notifications are independent; both may report the same completion.
Nested wait_agent({targets,...}) observes session-owned agents; outer wait({cell_id,...}) resumes a yielded exec cell. Agents outlive cells; completing or cancelling a cell does not close committed agents.`;
