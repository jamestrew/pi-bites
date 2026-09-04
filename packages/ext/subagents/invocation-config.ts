import { isThinkingLevel, type AgentConfig, type ThinkingLevel } from "./types.js";

interface AgentInvocationParams {
  model?: string;
  reasoning_effort?: string;
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
    thinking: isThinkingLevel(params.reasoning_effort)
      ? params.reasoning_effort
      : isThinkingLevel(agentConfig.thinking)
        ? agentConfig.thinking
        : undefined,
  };
}
