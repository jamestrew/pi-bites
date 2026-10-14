import { type AgentDetails } from "./ui/agent-format.js";
import type { WaitAgentStatus } from "./types.ts";

/** Tool execute return value for a text response. */
export function textResult<const TDetails = AgentDetails>(msg: string, details?: TDetails) {
  return { content: [{ type: "text" as const, text: msg }], details };
}

export type SubagentPayload =
  | ""
  | { message: string; timed_out: boolean }
  | { task_name: string }
  | { agents: Array<{ agent_name: string; agent_status: WaitAgentStatus }> }
  | { previous_status: WaitAgentStatus };

export class SubagentOperationError extends Error {
  constructor(
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "SubagentOperationError";
  }
}
