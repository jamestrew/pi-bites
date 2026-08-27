import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ShellAuthorizationStatus } from "./authorization.js";

export type BashGateApprovalResult =
  | { outcome: "allow"; authorization: Exclude<ShellAuthorizationStatus, "blocked"> }
  | { outcome: "allow-session"; authorization: "human-approved" }
  | { outcome: "deny"; source: "manual" | "automode"; rationale?: string }
  | { outcome: "failure"; message: string };

export interface ApprovalRequest {
  requestId: string;
  agentId?: string;
  title: string;
  command: string;
  toolName?: "bash" | "exec_command";
  labels: string[];
  reasons: string[];
  sessionAllowKey: string;
}

export interface BitesNotifyPayload {
  cwd: string;
  message: string;
}

export type BitesBashGatePayload = {
  cwd: string;
  command: string;
  toolName?: "bash" | "exec_command";
} & ({ requiresHuman: true; waitId: string } | { requiresHuman?: false; waitId?: never });

function approvalResult(value: unknown): BashGateApprovalResult | undefined {
  if (!value || typeof value !== "object" || !("outcome" in value)) return undefined;
  const result = value as Record<string, unknown>;
  if (
    result.outcome === "allow" &&
    (result.authorization === "not-reviewed" ||
      result.authorization === "reviewer-approved" ||
      result.authorization === "human-approved")
  ) {
    return { outcome: result.outcome, authorization: result.authorization };
  }
  if (result.outcome === "allow-session" && result.authorization === "human-approved") {
    return { outcome: result.outcome, authorization: result.authorization };
  }
  if (
    result.outcome === "deny" &&
    (result.source === "manual" || result.source === "automode") &&
    (result.rationale === undefined || typeof result.rationale === "string")
  ) {
    return {
      outcome: "deny",
      source: result.source,
      ...(typeof result.rationale === "string" ? { rationale: result.rationale } : {}),
    };
  }
  if (result.outcome === "failure" && typeof result.message === "string") {
    return { outcome: "failure", message: result.message };
  }
  return undefined;
}

export async function requestSubagentApproval(
  pi: ExtensionAPI,
  request: Omit<ApprovalRequest, "requestId">,
): Promise<BashGateApprovalResult> {
  const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const channel = "subagents:bash_gate:approval";
  const ackChannel = `${channel}:ack:${requestId}`;
  const replyChannel = `${channel}:reply:${requestId}`;

  return await new Promise<BashGateApprovalResult>((resolve) => {
    let settled = false;
    let acked = false;
    let unsubAck = () => {};
    let unsubReply = () => {};
    const settle = (result: BashGateApprovalResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(ackTimer);
      unsubAck();
      unsubReply();
      resolve(result);
    };

    unsubAck = pi.events.on(ackChannel, () => {
      acked = true;
    });
    unsubReply = pi.events.on(replyChannel, (reply) => {
      const result =
        reply && typeof reply === "object" && "result" in reply
          ? approvalResult(reply.result)
          : undefined;
      settle(result ?? { outcome: "failure", message: "malformed parent approval reply" });
    });

    const ackTimer = setTimeout(() => {
      if (!acked) settle({ outcome: "failure", message: "parent approval broker unavailable" });
    }, 250);

    pi.events.emit(channel, { requestId, ...request });
  });
}

export function onSubagentApprovalRequest(
  pi: ExtensionAPI,
  handler: (request: ApprovalRequest) => Promise<BashGateApprovalResult>,
): () => void {
  return pi.events.on("subagents:bash_gate:approval", async (data) => {
    const request = data as ApprovalRequest;
    const channel = "subagents:bash_gate:approval";
    pi.events.emit(`${channel}:ack:${request.requestId}`, {});
    let result: BashGateApprovalResult;
    try {
      result = await handler(request);
    } catch (error) {
      result = {
        outcome: "failure",
        message: error instanceof Error ? error.message : String(error),
      };
    }
    pi.events.emit(`${channel}:reply:${request.requestId}`, { result });
  });
}
