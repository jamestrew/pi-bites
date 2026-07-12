import type { AgentConfig, IsolationMode, JoinMode, ThinkingLevel } from "./types.js";

interface AgentInvocationParams {
  model?: string;
  thinking?: string;
  max_turns?: number;
  run_in_background?: boolean;
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
  maxTurns?: number;
  inheritContext: boolean;
  runInBackground: boolean;
  isolated: boolean;
  isolation?: IsolationMode;
} {
  return {
    modelInput: params.model ?? agentConfig?.model,
    modelFromParams: params.model != null,
    thinking: (params.thinking ?? agentConfig?.thinking) as ThinkingLevel | undefined,
    maxTurns: params.max_turns ?? agentConfig?.maxTurns,
    inheritContext: params.inherit_context ?? agentConfig?.inheritContext ?? false,
    runInBackground: params.run_in_background ?? agentConfig?.runInBackground ?? false,
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
