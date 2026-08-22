import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface SubagentSender {
  id: string;
  type: string;
  title: string;
}

export interface SubagentMessageDetails {
  sender: SubagentSender;
  message: string;
}

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
  let sessionId: string | undefined;
  const pending: SubagentMessageDetails[] = [];

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

  return {
    sessionStarted(id: string): void {
      if (sessionId !== id) pending.length = 0;
      sessionId = id;
      active = false;
    },
    sessionCleared(): void {
      sessionId = undefined;
      active = false;
      pending.length = 0;
    },
    agentStarted(): void {
      active = true;
    },
    agentSettled(): void {
      active = false;
      for (const details of pending.splice(0)) persist(details);
    },
    send(parentSessionId: string, sender: SubagentSender, message: string): boolean {
      if (parentSessionId !== sessionId) return false;
      const details = { sender, message };
      if (active) {
        pending.push(details);
        return true;
      }
      return persist(details);
    },
  };
}
