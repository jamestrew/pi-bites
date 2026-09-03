import { isThinkingLevel, type AgentConfig, type ThinkingLevel } from "./types.js";

interface AgentInvocationParams {
  model?: string;
  thinking?: string;
}

export function resolveAgentInvocationConfig(
  agentConfig: AgentConfig,
  params: AgentInvocationParams,
): {
  modelInput?: string;
  modelFromParams: boolean;
  thinking?: ThinkingLevel;
} {
  return {
    modelInput: params.model ?? agentConfig.model,
    modelFromParams: params.model != null,
    thinking: isThinkingLevel(params.thinking)
      ? params.thinking
      : isThinkingLevel(agentConfig.thinking)
        ? agentConfig.thinking
        : undefined,
  };
}
