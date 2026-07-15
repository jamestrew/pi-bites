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

import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { extractLastAssistantText } from "./utils.ts";
import type { BitesConfig } from "./config.js";
import type { BitesBashGatePayload, BitesNotifyPayload } from "./bash-gate/events.js";

export type { BitesBashGatePayload, BitesNotifyPayload } from "./bash-gate/events.js";

function platformNotify(title: string, body?: string): void {
  try {
    if (process.platform === "darwin") {
      const script = body
        ? `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`
        : `display notification "" with title ${JSON.stringify(title)}`;
      spawn("osascript", ["-e", script], { stdio: "ignore" }).on("error", () => {});
    } else {
      const args = body ? [title, body] : [title];
      spawn("notify-send", args, { stdio: "ignore" }).on("error", () => {});
    }
  } catch {
    /* fire-and-forget */
  }
}

function runCommand(command: string, payload: BitesNotifyPayload): void {
  try {
    const child = spawn(command, { shell: true, stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", () => {});
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  } catch {
    /* fire-and-forget */
  }
}

export default function registerNotifications(
  pi: ExtensionAPI,
  configRef: { current: BitesConfig },
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

  pi.events.on("bites:notify", (data) => notify(data as BitesNotifyPayload));

  pi.events.on("bites:bash_gate", (data) => {
    const { cwd, command } = data as BitesBashGatePayload;
    notify({ cwd, message: `Waiting for bash approval: ${command}` });
  });

  pi.on("agent_end", (event, ctx) => {
    notify({
      cwd: ctx.cwd,
      message: extractLastAssistantText(event.messages) ?? "Agent finished",
    });
  });
}
