/**
 * Notification Hooks
 *
 * Listens on the "bites:notify" event bus channel and fires a desktop
 * notification. Any extension can trigger a notification by emitting:
 *
 *   pi.events.emit("bites:notify", { cwd, message })
 *
 * By default uses `notify-send` (Linux) or `osascript` (macOS) with just the
 * title. A custom command can be configured instead — it receives the full
 * JSON payload on stdin, mirroring the Claude Code Notification hook contract:
 *
 *   { "cwd": "/path/to/project", "message": "..." }
 *
 * Configure via pi-bites.json:
 *
 * ```json
 * {
 *   "notifications": {
 *     "command": "~/.my-notify.sh"
 *   }
 * }
 * ```
 *
 * Set `command` to `""` to disable notifications entirely.
 */

import { execFile, spawn } from "node:child_process";
import type { AgentEndEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SnacksConfig } from "./config.js";

export interface BitesNotifyPayload {
  cwd: string;
  message: string;
}

export interface BitesBashGatePayload {
  cwd: string;
  command: string;
}

function extractLastAssistantText(messages: AgentEndEvent["messages"]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    const text = (msg.content as { type: string; text?: string }[])
      .filter((b) => b.type === "text" && b.text)
      .map((b) => b.text!)
      .join("")
      .trim();
    if (text) return text;
  }
  return "Agent finished";
}

function platformNotify(title: string, body?: string): void {
  try {
    if (process.platform === "darwin") {
      const script = body
        ? `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`
        : `display notification "" with title ${JSON.stringify(title)}`;
      execFile("osascript", ["-e", script], { stdio: "ignore" } as any);
    } else {
      const args = body ? [title, body] : [title];
      execFile("notify-send", args, { stdio: "ignore" } as any);
    }
  } catch {
    /* fire-and-forget */
  }
}

function runCommand(command: string, payload: BitesNotifyPayload): void {
  try {
    const child = spawn(command, { shell: true, stdio: ["pipe", "ignore", "ignore"] });
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  } catch {
    /* fire-and-forget */
  }
}

export default function registerNotifications(
  pi: ExtensionAPI,
  configRef: { current: SnacksConfig },
): void {
  function notify(payload: BitesNotifyPayload): void {
    const command = configRef.current.notifications?.command;
    if (command === "") return;

    if (command) {
      runCommand(command, payload);
    } else {
      platformNotify(`Pi — ${payload.cwd}`);
    }
  }

  pi.events.on("bites:notify", (data) => {
    notify(data as BitesNotifyPayload);
  });

  pi.events.on("bites:bash_gate", (data) => {
    const { cwd, command } = data as BitesBashGatePayload;
    notify({ cwd, message: `Waiting for bash approval: ${command}` });
  });

  pi.on("agent_end", (event, ctx) => {
    notify({
      cwd: ctx.cwd,
      message: extractLastAssistantText(event.messages),
    });
  });
}
