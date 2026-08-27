import { resolve } from "node:path";

const MIN_YIELD_TIME_MS = 250;
const MIN_NON_INTERACTIVE_EXEC_YIELD_TIME_MS = 5_000;
const MIN_EMPTY_WRITE_YIELD_TIME_MS = 30_000;
const MAX_YIELD_TIME_MS = 30_000;
export const MAX_EXEC_YIELD_TIME_MS = 1_800_000;
export const DEFAULT_EXEC_YIELD_TIME_MS = 30_000;
export const DEFAULT_WRITE_YIELD_TIME_MS = 250;
export const DEFAULT_MAX_EMPTY_WRITE_YIELD_TIME_MS = 240_000;

export function resolveWorkdir(baseCwd: string, workdir?: string): string {
  return workdir ? resolve(baseCwd, workdir) : baseCwd;
}

export function resolveShell(shell: string | undefined, defaultShell: string): string {
  const resolved = shell?.trim() || defaultShell;
  const name = resolved.replace(/\\/g, "/").split("/").pop()?.toLowerCase();
  // Codex commands assume Bourne syntax; fish cannot safely run them.
  return name === "fish" ? "bash" : resolved;
}

export function resolveExecution(
  command: string,
  extraEnv?: NodeJS.ProcessEnv,
  baseEnv: NodeJS.ProcessEnv = process.env,
): { command: string; env: NodeJS.ProcessEnv } {
  return { command, env: { ...baseEnv, ...extraEnv } };
}

export function getShellArgs(shell: string, command: string, login: boolean): string[] {
  const name = shell.replace(/\\/g, "/").split("/").pop()?.toLowerCase();
  if (name === "cmd" || name === "cmd.exe") return ["/d", "/s", "/c", command];
  if (
    name === "powershell" ||
    name === "powershell.exe" ||
    name === "pwsh" ||
    name === "pwsh.exe"
  ) {
    return ["-NoLogo", "-NoProfile", "-Command", command];
  }
  return login ? ["-lc", command] : ["-c", command];
}

export function normalizeMinNonInteractiveExecYieldTime(value: number | undefined): number {
  return Math.min(
    MAX_EXEC_YIELD_TIME_MS,
    Math.max(MIN_YIELD_TIME_MS, value ?? MIN_NON_INTERACTIVE_EXEC_YIELD_TIME_MS),
  );
}

export function normalizeMinEmptyWriteYieldTime(value: number | undefined): number {
  return Math.min(
    MAX_YIELD_TIME_MS,
    Math.max(MIN_YIELD_TIME_MS, value ?? MIN_EMPTY_WRITE_YIELD_TIME_MS),
  );
}

export function clampExecYieldTime(
  yieldTimeMs: number | undefined,
  fallback: number,
  isInteractive: boolean,
  minNonInteractiveExecYieldTimeMs: number,
  maxYieldTimeMs = MAX_EXEC_YIELD_TIME_MS,
): number {
  const value = Math.min(maxYieldTimeMs, Math.max(MIN_YIELD_TIME_MS, yieldTimeMs ?? fallback));
  return isInteractive
    ? value
    : Math.min(maxYieldTimeMs, Math.max(minNonInteractiveExecYieldTimeMs, value));
}

export function clampWriteYieldTime(
  yieldTimeMs: number | undefined,
  fallback: number,
  isEmptyPoll: boolean,
  minEmptyWriteYieldTimeMs: number,
  maxEmptyWriteYieldTimeMs: number,
): number {
  return isEmptyPoll
    ? Math.min(
        maxEmptyWriteYieldTimeMs,
        Math.max(minEmptyWriteYieldTimeMs, yieldTimeMs ?? fallback),
      )
    : Math.min(MAX_YIELD_TIME_MS, Math.max(MIN_YIELD_TIME_MS, yieldTimeMs ?? fallback));
}
