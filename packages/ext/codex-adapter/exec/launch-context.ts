import { getAgentDir, getShellConfig, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ToolExecutionContext } from "../tool-execution.js";
import { resolveShell, resolveWorkdir } from "./shell.js";

/** Resolve once before approval, then use these same fields for the launch. */
export function pinExecLaunch(
  input: { workdir?: string; shell?: string; login?: boolean; tty?: boolean },
  ctx: Pick<ToolExecutionContext, "cwd" | "isProjectTrusted">,
) {
  const cwd = resolveWorkdir(ctx.cwd, input.workdir);
  const defaultShell = input.shell?.trim()
    ? input.shell
    : getShellConfig(
        SettingsManager.create(ctx.cwd, getAgentDir(), {
          projectTrusted: ctx.isProjectTrusted(),
        }).getShellPath(),
      ).shell;
  const shell = resolveShell(input.shell, defaultShell);
  const login = input.login ?? true;
  const tty = input.tty ?? false;
  Object.assign(input, { workdir: cwd, shell, login, tty });
  return { cwd, shell, login, tty };
}
