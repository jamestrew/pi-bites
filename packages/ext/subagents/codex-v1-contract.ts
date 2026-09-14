/** Generated, capability-filtered V1 declarations; no nested tools are activated here. */
import generated from "../../../docs/code-mode-contract/subagents-supported.json" with { type: "json" };

export const CODEX_V1_UPSTREAM_REVISION = generated.revision;
export const CODEX_V1_SOURCE_PATHS = generated.source_paths;
export const CODEX_V1_AGENT_STATUSES = generated.agent_statuses;
export const CODEX_V1_TOOL_NAMES = [
  "spawn_agent",
  "send_input",
  "wait_agent",
  "close_agent",
  "resume_agent",
] as const;

export const CODEX_V1_CONTRACT = generated.contract;
/** Native namespace-derived identities and full input/return declarations, metadata only. */
export const CODEX_V1_NESTED_TOOLS = generated.nested_tools;
export const CODEX_V1_EDITS = generated.edits;

/** Serialize every field of the supported five-tool direct surface. */
export function serializeCodexV1Contract(): string {
  return JSON.stringify(Object.values(CODEX_V1_CONTRACT.tools));
}

/** Conservative reporting estimate; the historical 2,902 tokens is not a ceiling. */
export function estimateCodexV1ContractTokens(): number {
  return Math.ceil(serializeCodexV1Contract().length / 4);
}
