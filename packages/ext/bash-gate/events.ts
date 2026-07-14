import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type BashGateDecision = "allow" | "allow-session" | "deny";

export interface ApprovalRequest {
  requestId: string;
  agentId?: string;
  title: string;
  command: string;
  labels: string[];
  reasons: string[];
  sessionAllowKey: string;
}

export interface BitesNotifyPayload {
  cwd: string;
  message: string;
}

export interface BitesBashGatePayload {
  cwd: string;
  command: string;
}

interface BashGateEventMap {
  "bites:bash_gate": BitesBashGatePayload;
  "bites:bash_gate_resolved": BitesBashGatePayload;
  "bites:notify": BitesNotifyPayload;
  "subagents:bash_gate:approval": ApprovalRequest;
}

declare module "@earendil-works/pi-coding-agent" {
  interface EventBus {
    on<K extends keyof BashGateEventMap>(
      channel: K,
      handler: (data: BashGateEventMap[K]) => void,
    ): () => void;
  }
}

export function onBashGateEvent<K extends keyof BashGateEventMap>(
  pi: ExtensionAPI,
  channel: K,
  handler: (data: BashGateEventMap[K]) => void,
): () => void {
  return pi.events.on(channel, handler);
}

export function emitBashGateEvent<K extends keyof BashGateEventMap>(
  pi: ExtensionAPI,
  channel: K,
  data: BashGateEventMap[K],
): void {
  pi.events.emit(channel, data);
}

export async function requestSubagentApproval(
  pi: ExtensionAPI,
  request: Omit<ApprovalRequest, "requestId">,
): Promise<BashGateDecision> {
  const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const channel = "subagents:bash_gate:approval";
  const ackChannel = `${channel}:ack:${requestId}`;
  const replyChannel = `${channel}:reply:${requestId}`;

  return await new Promise<BashGateDecision>((resolve) => {
    let settled = false;
    let acked = false;
    let unsubAck = () => {};
    let unsubReply = () => {};
    const settle = (decision: BashGateDecision) => {
      if (settled) return;
      settled = true;
      clearTimeout(ackTimer);
      unsubAck();
      unsubReply();
      resolve(decision);
    };

    unsubAck = pi.events.on(ackChannel, () => {
      acked = true;
    });
    unsubReply = pi.events.on(replyChannel, (reply) => {
      if (typeof reply !== "object" || reply === null || !("decision" in reply)) {
        settle("deny");
        return;
      }
      const { decision } = reply;
      settle(decision === "allow" || decision === "allow-session" ? decision : "deny");
    });

    const ackTimer = setTimeout(() => {
      if (!acked) settle("deny");
    }, 250);

    emitBashGateEvent(pi, channel, { requestId, ...request });
  });
}

export function onSubagentApprovalRequest(
  pi: ExtensionAPI,
  handler: (request: ApprovalRequest) => Promise<BashGateDecision>,
): () => void {
  return onBashGateEvent(pi, "subagents:bash_gate:approval", async (request) => {
    const channel = "subagents:bash_gate:approval";
    pi.events.emit(`${channel}:ack:${request.requestId}`, {});
    let decision: BashGateDecision = "deny";
    try {
      decision = await handler(request);
    } finally {
      pi.events.emit(`${channel}:reply:${request.requestId}`, { decision });
    }
  });
}
