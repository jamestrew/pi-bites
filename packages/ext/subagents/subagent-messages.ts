import { randomUUID } from "node:crypto";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { WaitAgentSender } from "./types.js";

export type SubagentSender = WaitAgentSender;

export interface SubagentMessageDetails {
  sender: SubagentSender;
  message: string;
  activityId?: string;
  completion?: "completed" | "failed";
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

export function createSubagentMessenger(
  pi: Pick<ExtensionAPI, "sendMessage">,
  onActivity?: (pending: number) => void,
) {
  let active = false;
  let flushing = false;
  let disposed = false;
  let sessionId: string | undefined;
  let appendCustomMessage: AppendCustomMessage | undefined;
  let afterTerminalOutput = false;
  const activity = new Map<string, boolean>();
  const waiters = new Set<(event: "mail" | "input" | "cancelled") => void>();
  const wake = (event: "mail" | "input" | "cancelled") => {
    for (const waiter of waiters) waiter(event);
  };
  let inputPending: (() => boolean) | undefined;
  let inputTimer: ReturnType<typeof setTimeout> | undefined;
  const stopInputCheck = () => {
    clearTimeout(inputTimer);
    inputTimer = undefined;
  };
  const checkInput = () => {
    stopInputCheck();
    if (!waiters.size || !inputPending) return;
    try {
      if (inputPending()) {
        wake("input");
        return;
      }
    } catch {
      // Pi guards even extracted methods after replacement. Never leak that failure.
      inputPending = undefined;
      wake("cancelled");
      return;
    }
    // Pi has no extension post-enqueue event; input hooks can await later handlers.
    inputTimer = setTimeout(checkInput, 25);
  };
  let revision = 0;
  const publishActivity = () => {
    try {
      onActivity?.(activity.size);
    } catch {
      /* UI failure does not revoke accepted input. */
    }
  };
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
        wake("cancelled");
        inputPending = undefined;
        stopInputCheck();
        activity.clear();
        publishActivity();
        revision = 0;
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
      wake("cancelled");
      inputPending = undefined;
      stopInputCheck();
      activity.clear();
      publishActivity();
      sessionId = undefined;
      appendCustomMessage = undefined;
      active = false;
      afterTerminalOutput = false;
      pending.length = 0;
      pendingNextTurn.length = 0;
      cancelFinals();
    },
    /** Native queue-only delivery owns persistence; this map tracks only unseen activity. */
    queueOnly(
      targetSessionId: string,
      sender: SubagentSender,
      message: string,
      task = false,
      completion?: SubagentMessageDetails["completion"],
    ): boolean {
      if (disposed || targetSessionId !== sessionId) return false;
      const activityId = randomUUID();
      const details = { sender, message, activityId, ...(completion ? { completion } : {}) };
      activity.set(activityId, task);
      if (!persist(details)) {
        activity.delete(activityId);
        return false;
      }
      revision++;
      publishActivity();
      wake("mail");
      return true;
    },
    wait(timeoutMs: number, signal?: AbortSignal): Promise<"mail" | "input" | "timeout"> {
      signal?.throwIfAborted();
      if (disposed || !sessionId) return Promise.reject(new Error("Mailbox is unavailable"));
      if (activity.size > 0) return Promise.resolve("mail");
      return new Promise((resolve, reject) => {
        const finish = (event: "mail" | "input" | "timeout" | "cancelled") => {
          clearTimeout(timer);
          waiters.delete(finish);
          if (!waiters.size) stopInputCheck();
          signal?.removeEventListener("abort", abort);
          if (event === "cancelled") reject(new Error("Wait cancelled."));
          else resolve(event);
        };
        const abort = () => finish("cancelled");
        const timer = setTimeout(() => finish("timeout"), timeoutMs);
        waiters.add(finish);
        signal?.addEventListener("abort", abort, { once: true });
        // Subscribe before rechecking: a pending arrival is never consumed by a wait.
        if (signal?.aborted) abort();
        else if (activity.size > 0) finish("mail");
        else checkInput();
      });
    },
    userInput(hasPendingMessages: () => boolean): void {
      if (disposed) return;
      inputPending = hasPendingMessages;
      checkInput();
    },
    observe() {
      return {
        revision,
        pending: activity.size,
        pendingTasks: [...activity.values()].filter(Boolean).length,
      };
    },
    contextPrepared(messages: readonly { role: string; details?: unknown }[]): void {
      for (const message of messages) {
        if (message.role !== "custom") continue;
        const details = message.details as Partial<SubagentMessageDetails> | undefined;
        if (typeof details?.activityId === "string" && activity.delete(details.activityId))
          publishActivity();
      }
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

/** Bind the same delivery state machine at each live session-tree node. */
export function bindSubagentMessenger(
  pi: ExtensionAPI,
  messenger: ReturnType<typeof createSubagentMessenger>,
  started?: (id: string) => void,
) {
  const start = (ctx: ExtensionContext) => {
    const manager = ctx.sessionManager as SessionManager;
    const id = manager.getSessionId();
    messenger.sessionStarted(id, (type, content, display, details) =>
      manager.appendCustomMessageEntry(type, content, display, details),
    );
    started?.(id);
  };
  pi.on("input", (event, ctx) => {
    if (event.source !== "extension") messenger.userInput(ctx.hasPendingMessages.bind(ctx));
    return { action: "continue" };
  });
  pi.on("context", (event) => messenger.contextPrepared(event.messages));
  pi.on("agent_before_settle", () => {
    if (messenger.observe().pendingTasks > 0) return { continue: true };
  });
  pi.on("agent_start", () => messenger.agentStarted());
  pi.on("turn_start", () => messenger.turnStarted());
  pi.on("message_end", (event) => {
    if (event.message.role === "assistant")
      messenger.assistantMessageEnded(
        !event.message.content.some((part) => part.type === "toolCall"),
        event.message.stopReason === "aborted",
      );
  });
  pi.on("turn_end", () => messenger.turnEnded());
  pi.on("agent_settled", (_event, ctx) => {
    if (ctx.isIdle()) messenger.agentSettled();
  });
  return start;
}
