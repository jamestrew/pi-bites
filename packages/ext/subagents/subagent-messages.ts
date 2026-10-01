import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WaitAgentSender } from "./types.js";

export type SubagentSender = WaitAgentSender;

export interface SubagentMessageDetails {
  sender: SubagentSender;
  message: string;
  activityId?: string;
  /** True only for followup_task, not queue-only information or completion mail. */
  task?: boolean;
  completion?: "completed" | "failed";
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

export function createSubagentMessenger(
  pi: Pick<ExtensionAPI, "sendMessage">,
  onActivity?: (pending: number) => void,
) {
  let disposed = false;
  let sessionId: string | undefined;
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
      if (sessionId !== id) {
        wake("cancelled");
        inputPending = undefined;
        stopInputCheck();
        activity.clear();
        publishActivity();
        revision = 0;
      }
      sessionId = id;
      disposed = false;
    },
    dispose(): void {
      disposed = true;
      wake("cancelled");
      inputPending = undefined;
      stopInputCheck();
      activity.clear();
      publishActivity();
      sessionId = undefined;
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
      const details = {
        sender,
        message,
        activityId,
        ...(task ? { task: true } : {}),
        ...(completion ? { completion } : {}),
      };
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
  };
}

/** Bind the same delivery state machine at each live session-tree node. */
export function bindSubagentMessenger(
  pi: ExtensionAPI,
  messenger: ReturnType<typeof createSubagentMessenger>,
  started?: (id: string) => void,
) {
  const start = (ctx: ExtensionContext) => {
    const id = ctx.sessionManager.getSessionId();
    messenger.sessionStarted(id);
    started?.(id);
  };
  pi.on("input", (event, ctx) => {
    if (event.source !== "extension") messenger.userInput(ctx.hasPendingMessages.bind(ctx));
    return { action: "continue" };
  });
  pi.on("context", (event) => messenger.contextPrepared(event.messages));
  pi.on("session_before_compact", () => {
    // Summaries lose unread payloads' attribution and activity IDs. Compact after inference sees them.
    if (messenger.observe().pending > 0) return { cancel: true };
  });
  pi.on("agent_before_settle", () => {
    if (messenger.observe().pendingTasks > 0) return { continue: true };
  });
  return start;
}
