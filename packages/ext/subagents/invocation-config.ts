import {
  isThinkingLevel,
  type AgentConfig,
  type IsolationMode,
  type ThinkingLevel,
} from "./types.js";

interface AgentInvocationParams {
  model?: string;
  thinking?: string;
  inherit_context?: boolean;
  isolated?: boolean;
  isolation?: IsolationMode;
}

export function resolveAgentInvocationConfig(
  agentConfig: AgentConfig | undefined,
  params: AgentInvocationParams,
): {
  modelInput?: string;
  modelFromParams: boolean;
  thinking?: ThinkingLevel;
  inheritContext: boolean;
  isolated: boolean;
  isolation?: IsolationMode;
} {
  return {
    modelInput: params.model ?? agentConfig?.model,
    modelFromParams: params.model != null,
    thinking: isThinkingLevel(params.thinking)
      ? params.thinking
      : isThinkingLevel(agentConfig?.thinking)
        ? agentConfig.thinking
        : undefined,
    inheritContext: params.inherit_context ?? agentConfig?.inheritContext ?? false,
    isolated: agentConfig?.isolated ?? params.isolated ?? false,
    isolation: params.isolation ?? agentConfig?.isolation,
  };
}
