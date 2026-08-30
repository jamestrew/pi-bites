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
  let afterTerminalOutput = false;
  const pending: SubagentMessageDetails[] = [];
  const pendingNextTurn: SubagentMessageDetails[] = [];
  const pendingFinals: Array<{ deliver: () => void; cancel?: () => void }> = [];

  const persist = (details: SubagentMessageDetails, deliverAs?: "steer"): boolean => {
    try {
      pi.sendMessage<SubagentMessageDetails>(
        {
          customType: "subagent-message",
          content: modelContent(details),
          display: true,
          details,
        },
        deliverAs ? { deliverAs } : { triggerTurn: false },
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

  const deliverFinals = (): void => {
    for (const { deliver } of pendingFinals.splice(0)) {
      try {
        deliver();
      } catch {
        /* one failed delivery must not suppress later finals */
      }
    }
  };

  const cancelFinals = (): void => {
    for (const { cancel } of pendingFinals.splice(0)) {
      try {
        cancel?.();
      } catch {
        /* one failed cancellation must not suppress later cancellations */
      }
    }
  };

  const drainCurrentTurn = (): void => {
    if (disposed || flushing) return;
    flushing = true;
    try {
      while (pending.length > 0) {
        for (const details of pending.splice(0)) persist(details, "steer");
      }
      if (pendingNextTurn.length === 0) deliverFinals();
    } finally {
      flushing = false;
    }
  };

  const drainAll = (deliverIntermediate: (details: SubagentMessageDetails) => boolean): void => {
    if (disposed || flushing) return;
    flushing = true;
    try {
      while (pending.length > 0 || pendingNextTurn.length > 0) {
        for (const details of pending.splice(0)) deliverIntermediate(details);
        for (const details of pendingNextTurn.splice(0)) deliverIntermediate(details);
      }
      deliverFinals();
    } finally {
      flushing = false;
    }
  };

  const flush = (): void => drainAll(persist);
  const flushForShutdown = (): void => drainAll(persistForShutdown);

  return {
    sessionStarted(id: string, append?: AppendCustomMessage): void {
      if (sessionId !== id) {
        pending.length = 0;
        pendingNextTurn.length = 0;
        cancelFinals();
      }
      sessionId = id;
      appendCustomMessage = append;
      active = false;
      afterTerminalOutput = false;
      disposed = false;
    },
    agentStarted(): void {
      if (!disposed && sessionId) {
        active = true;
        afterTerminalOutput = false;
      }
    },
    turnStarted(): void {
      afterTerminalOutput = false;
    },
    assistantMessageEnded(terminal: boolean, cancelled = false): void {
      if (!active) return;
      if (cancelled) pendingNextTurn.push(...pending.splice(0));
      if (terminal) afterTerminalOutput = true;
    },
    turnEnded(): void {
      drainCurrentTurn();
    },
    agentSettled(): void {
      active = false;
      afterTerminalOutput = false;
      flush();
    },
    flush,
    flushForShutdown,
    dispose(): void {
      disposed = true;
      sessionId = undefined;
      appendCustomMessage = undefined;
      active = false;
      afterTerminalOutput = false;
      pending.length = 0;
      pendingNextTurn.length = 0;
      cancelFinals();
    },
    scheduleFinal(parentSessionId: string, deliver: () => void, cancel?: () => void): boolean {
      if (disposed || parentSessionId !== sessionId) return false;
      if (flushing || pending.length > 0 || pendingNextTurn.length > 0) {
        pendingFinals.push({ deliver, cancel });
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
        (afterTerminalOutput || pendingNextTurn.length > 0 ? pendingNextTurn : pending).push(
          details,
        );
        return true;
      }
      return persist(details);
    },
  };
}
