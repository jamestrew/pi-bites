import { DEFAULT_AGENTS } from "./default-agents.js";
import { SUBAGENT_TYPES, type AgentConfig, type SubagentType } from "./types.js";

export type ResolvedAgent = {
  type: SubagentType;
  config: AgentConfig;
  matched: boolean;
};

export type SpawnAgentResolution = { agent: ResolvedAgent } | { error: string };

/** Resolve an embedded role case-insensitively, defaulting omitted and unknown roles. */
export function resolveAgent(requestedType?: string): ResolvedAgent {
  const requested = requestedType?.trim().toLowerCase() || "default";
  const type = SUBAGENT_TYPES.find((candidate) => candidate === requested) ?? "default";
  const config = DEFAULT_AGENTS[type];
  return { type, config, matched: type === requested };
}

/** Apply spawn_agent's role defaults and full-history inheritance rules. */
export function resolveSpawnAgent(
  requestedType: string | undefined,
  forkContext: boolean | undefined,
  parentType: string | undefined,
): SpawnAgentResolution {
  const requested = requestedType?.trim() || undefined;
  if (forkContext && requested) {
    return {
      error:
        "Full-history forked agents inherit the parent agent type; omit agent_type, or spawn without a full-history fork.",
    };
  }
  const agent = resolveAgent(requested ?? (forkContext ? parentType : undefined));
  if (requested && !agent.matched) return { error: `Unknown agent_type '${requested}'.` };
  return { agent };
}
