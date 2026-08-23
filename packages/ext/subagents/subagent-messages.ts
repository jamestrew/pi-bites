import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { WaitAgentSender } from "./types.js";

export type SubagentSender = WaitAgentSender;

export interface SubagentMessageDetails {
  sender: SubagentSender;
  message: string;
}

type AppendCustomMessage = (
  customType: string,
  content: string,
  display: boolean,
  details: SubagentMessageDetails,
) => unknown;

function escapeXml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function modelContent({ sender, message }: SubagentMessageDetails): string {
  return [
    "<subagent-message>",
    `<sender_id>${escapeXml(sender.id)}</sender_id>`,
    `<sender_type>${escapeXml(sender.type)}</sender_type>`,
    `<sender_title>${escapeXml(sender.title)}</sender_title>`,
    `<message>${escapeXml(message)}</message>`,
    "</subagent-message>",
  ].join("\n");
}

export function createSubagentMessenger(pi: Pick<ExtensionAPI, "sendMessage">) {
  let active = false;
  let flushing = false;
  let disposed = false;
  let sessionId: string | undefined;
  let appendCustomMessage: AppendCustomMessage | undefined;
  const pending: SubagentMessageDetails[] = [];
  const pendingFinals: Array<() => void> = [];

  const persist = (details: SubagentMessageDetails): boolean => {
    try {
      pi.sendMessage<SubagentMessageDetails>(
        {
          customType: "subagent-message",
          content: modelContent(details),
          display: true,
          details,
        },
        { triggerTurn: false },
      );
      return true;
    } catch {
      return false;
    }
  };

  const persistForShutdown = (details: SubagentMessageDetails): boolean => {
    if (!appendCustomMessage) return false;
    try {
      appendCustomMessage("subagent-message", modelContent(details), true, details);
      return true;
    } catch {
      return false;
    }
  };

  const drain = (deliverIntermediate: (details: SubagentMessageDetails) => boolean): void => {
    if (disposed || flushing) return;
    flushing = true;
    try {
      while (pending.length > 0) {
        for (const details of pending.splice(0)) deliverIntermediate(details);
      }
      for (const deliver of pendingFinals.splice(0)) {
        try {
          deliver();
        } catch {
          /* one failed delivery must not suppress later finals */
        }
      }
    } finally {
      flushing = false;
    }
  };

  const flush = (): void => drain(persist);
  const flushForShutdown = (): void => drain(persistForShutdown);

  return {
    sessionStarted(id: string, append?: AppendCustomMessage): void {
      if (sessionId !== id) {
        pending.length = 0;
        pendingFinals.length = 0;
      }
      sessionId = id;
      appendCustomMessage = append;
      active = false;
      disposed = false;
    },
    agentStarted(): void {
      if (!disposed && sessionId) active = true;
    },
    agentSettled(): void {
      active = false;
      flush();
    },
    flush,
    flushForShutdown,
    dispose(): void {
      disposed = true;
      sessionId = undefined;
      appendCustomMessage = undefined;
      active = false;
      pending.length = 0;
      pendingFinals.length = 0;
    },
    scheduleFinal(parentSessionId: string, deliver: () => void): boolean {
      if (disposed || parentSessionId !== sessionId) return false;
      if (flushing || pending.length > 0) {
        pendingFinals.push(deliver);
        return true;
      }
      try {
        deliver();
        return true;
      } catch {
        return false;
      }
    },
    send(parentSessionId: string, sender: SubagentSender, message: string): boolean {
      if (disposed || parentSessionId !== sessionId) return false;
      const details = { sender, message };
      if (active || flushing) {
        pending.push(details);
        return true;
      }
      return persist(details);
    },
  };
}
