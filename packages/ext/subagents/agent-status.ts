import type { AgentRecord, WaitAgentStatus } from "./types.js";

/** Convert manager state to the pinned Codex V1 status vocabulary. */
export function getAgentStatus(record: AgentRecord, includeOutput = true): WaitAgentStatus {
  switch (record.status) {
    case "queued":
      return "pending_init";
    case "running":
      return "running";
    case "completed":
      return { completed: includeOutput && record.result?.trim() ? record.result : null };
    case "error":
      return { errored: includeOutput ? (record.error ?? "unknown error") : "" };
    case "stopped":
      return record.abort?.source === "interrupt" ? "interrupted" : "shutdown";
  }
}
