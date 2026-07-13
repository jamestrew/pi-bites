/**
 * Script Statusline
 *
 * Runs a shell command after each agent turn and displays its stdout in the
 * status bar. Good for surfacing any live stats — token quotas, test counts,
 * build status, etc.
 *
 * Configure via pi-bites.json:
 *
 * ```json
 * {
 *   "statusline": {
 *     "command": "python get_usage_limits.py"
 *   }
 * }
 * ```
 *
 * The command runs in ctx.cwd. Its trimmed stdout is shown verbatim in the
 * statusline. If `command` is not configured, the statusline is left alone.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BitesConfig } from "./config.js";

const execAsync = promisify(exec);

async function updateStatus(
  cwd: string,
  command: string,
  setStatus: (text: string | undefined) => void,
  fg: (color: "dim" | "error", text: string) => string,
): Promise<void> {
  try {
    const { stdout } = await execAsync(command, { cwd });
    const output = stdout.trim();
    setStatus(output ? fg("dim", output) : undefined);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message.split("\n")[0] : "error";
    setStatus(fg("error", msg));
  }
}

export default function registerStatusline(pi: ExtensionAPI, configRef: { current: BitesConfig }) {
  const run = (ctx: ExtensionContext) => {
    const command = configRef.current.statusline?.command;
    if (!command) return;
    return updateStatus(
      ctx.cwd,
      command,
      (text) => {
        try {
          ctx.ui.setStatus("statusline", text);
        } catch {
          /* stale ctx */
        }
      },
      (color: "dim" | "error", text: string) => {
        try {
          return ctx.ui.theme.fg(color, text);
        } catch {
          return text;
        }
      },
    );
  };

  pi.on("session_start", async (_event, ctx) => {
    await run(ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    await run(ctx);
  });
}
