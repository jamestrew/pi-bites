import { isThinkingLevel, type AgentConfig, type ThinkingLevel } from "./types.js";

interface AgentInvocationParams {
  model?: string;
  thinking?: string;
  isolated?: boolean;
}

export function resolveAgentInvocationConfig(
  agentConfig: AgentConfig | undefined,
  params: AgentInvocationParams,
): {
  modelInput?: string;
  modelFromParams: boolean;
  thinking?: ThinkingLevel;
  isolated: boolean;
} {
  return {
    modelInput: params.model ?? agentConfig?.model,
    modelFromParams: params.model != null,
    thinking: isThinkingLevel(params.thinking)
      ? params.thinking
      : isThinkingLevel(agentConfig?.thinking)
        ? agentConfig.thinking
        : undefined,
    isolated: agentConfig?.isolated ?? params.isolated ?? false,
  };
}
