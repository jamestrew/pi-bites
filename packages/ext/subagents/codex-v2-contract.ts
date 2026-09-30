/** Pinned, provider-neutral V2 declarations only; importing does not register executors. */
import generated from "../../../docs/code-mode-contract/subagents-v2-supported.json" with { type: "json" };

export const CODEX_V2_UPSTREAM_REVISION = generated.revision;
export const CODEX_V2_SOURCE_PATHS = generated.source_paths;
export const CODEX_V2_TOOL_NAMES = [
  "spawn_agent",
  "send_message",
  "followup_task",
  "wait_agent",
  "interrupt_agent",
  "list_agents",
] as const;
export const CODEX_V2_CONTRACT = generated.contract;
export const CODEX_V2_EDITS = generated.edits;
export const CODEX_V2_AGENT_STATUS_SCHEMA = generated.agent_status_schema;

export function serializeCodexV2Contract(): string {
  return JSON.stringify(Object.values(CODEX_V2_CONTRACT.tools));
}
