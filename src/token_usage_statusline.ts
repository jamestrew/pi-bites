import { exec } from "node:child_process";
import { access } from "node:fs/promises";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const execAsync = promisify(exec);

async function scriptExists(cwd: string): Promise<boolean> {
  try {
    await access(`${cwd}/get_usage_limits.py`);
    return true;
  } catch {
    return false;
  }
}

async function updateUsageStatus(
  cwd: string,
  setStatus: (text: string) => void,
  fg: (color: string, text: string) => string,
): Promise<void> {
  if (!(await scriptExists(cwd))) {
    setStatus(fg("dim", "Usage: no script"));
    return;
  }

  try {
    const { stdout } = await execAsync("python get_usage_limits.py", { cwd });
    const output = stdout.trim();
    setStatus(fg("dim", output || "Usage: (empty)"));
  } catch (err: any) {
    const msg = err?.message?.split("\n")[0] ?? "error";
    setStatus(fg("error", `Usage: ${msg}`));
  }
}

export function registerTokenUsageStatusline(pi: ExtensionAPI) {
  const update = (ctx: any) =>
    updateUsageStatus(
      ctx.cwd,
      (text) => ctx.ui.setStatus("token-usage", text),
      (color: string, text: string) => ctx.ui.theme.fg(color, text),
    );

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setStatus("token-usage", ctx.ui.theme.fg("dim", "Usage: —"));
    await update(ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    await update(ctx);
  });
}
