import type { WaitAgentStatus } from "../types.js";

export function lifecycleStatusLabel(status: WaitAgentStatus, pendingInitLabel: string): string {
  if (typeof status === "string") return status === "pending_init" ? pendingInitLabel : status;
  if ("completed" in status) return "completed";
  return "errored";
}
