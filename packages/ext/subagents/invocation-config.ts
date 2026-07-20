import {
  isThinkingLevel,
  type AgentConfig,
  type IsolationMode,
  type JoinMode,
  type ThinkingLevel,
} from "./types.js";

interface AgentInvocationParams {
  model?: string;
  thinking?: string;
  run_in_background?: boolean;
  inherit_context?: boolean;
  isolated?: boolean;
  isolation?: IsolationMode;
}

export function resolveRunInBackground(
  agentConfig: AgentConfig | undefined,
  runInBackground: boolean | undefined,
): boolean {
  return runInBackground ?? agentConfig?.runInBackground ?? true;
}

export function resolveAgentInvocationConfig(
  agentConfig: AgentConfig | undefined,
  params: AgentInvocationParams,
): {
  modelInput?: string;
  modelFromParams: boolean;
  thinking?: ThinkingLevel;
  inheritContext: boolean;
  runInBackground: boolean;
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
    runInBackground: resolveRunInBackground(agentConfig, params.run_in_background),
    isolated: agentConfig?.isolated ?? params.isolated ?? false,
    isolation: params.isolation ?? agentConfig?.isolation,
  };
}

export function resolveJoinMode(
  defaultJoinMode: JoinMode,
  runInBackground: boolean,
): JoinMode | undefined {
  return runInBackground ? defaultJoinMode : undefined;
}
