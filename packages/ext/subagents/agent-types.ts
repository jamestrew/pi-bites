import { DEFAULT_AGENTS } from "./default-agents.js";
import { SUBAGENT_TYPES, type AgentConfig, type SubagentType } from "./types.js";

export type ResolvedAgent = {
  type: SubagentType;
  config: AgentConfig;
  matched: boolean;
};

/** Resolve an embedded role case-insensitively, falling back to general. */
export function resolveAgent(requestedType: string): ResolvedAgent {
  const requested = requestedType.toLowerCase();
  const type = SUBAGENT_TYPES.find((candidate) => candidate === requested) ?? "general";
  const config = DEFAULT_AGENTS[type];
  return { type, config, matched: type === requested };
}
