import { Text } from "@earendil-works/pi-tui";
import {
  getAgentDir,
  getShellConfig,
  SettingsManager,
  type AgentToolResult,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

import { formatUnifiedExecResult } from "./format.js";
import type { ExecSessionManager, UnifiedExecResult } from "./session-manager.js";

const parameters = Type.Object({
  cmd: Type.String({ description: "The shell command to run." }),
  workdir: Type.Optional(
    Type.String({ description: "Working directory, relative to the session cwd or absolute." }),
  ),
  shell: Type.Optional(
    Type.String({ description: "Shell executable. Defaults to Pi's configured shell." }),
  ),
  tty: Type.Optional(Type.Boolean({ description: "Run in an interactive pseudo-terminal." })),
  yield_time_ms: Type.Optional(
    Type.Number({ description: "Wait time before returning a resumable session." }),
  ),
  max_output_tokens: Type.Optional(
    Type.Number({ description: "Maximum approximate output tokens returned." }),
  ),
  login: Type.Optional(
    Type.Boolean({ description: "Start the shell as a login shell. Defaults to true." }),
  ),
});

function canonicalArguments(args: unknown): Static<typeof parameters> {
  if (!args || typeof args !== "object") return args as Static<typeof parameters>;
  const value = args as Record<string, unknown>;
  return {
    cmd: (value.cmd ?? value.command) as string,
    ...(typeof (value.workdir ?? value.cwd) === "string"
      ? { workdir: (value.workdir ?? value.cwd) as string }
      : {}),
    ...(typeof value.shell === "string" ? { shell: value.shell } : {}),
    ...(typeof value.tty === "boolean" ? { tty: value.tty } : {}),
    ...(typeof (value.yield_time_ms ?? value.yield_time) === "number"
      ? { yield_time_ms: (value.yield_time_ms ?? value.yield_time) as number }
      : {}),
    ...(typeof value.max_output_tokens === "number"
      ? { max_output_tokens: value.max_output_tokens }
      : {}),
    ...(typeof value.login === "boolean" ? { login: value.login } : {}),
  } as Static<typeof parameters>;
}

function toolResult(
  result: UnifiedExecResult,
  command: string,
): AgentToolResult<UnifiedExecResult> {
  return {
    content: [{ type: "text", text: formatUnifiedExecResult(result, command) }],
    details: result,
  };
}

export function createExecCommandTool(
  sessions: ExecSessionManager,
): ToolDefinition<typeof parameters, UnifiedExecResult> {
  return {
    name: "exec_command",
    label: "exec_command",
    description:
      "Run a shell command. Long-running commands return a session_id that can be resumed with write_stdin.",
    promptSnippet: "Run shell commands with resumable sessions",
    executionMode: "parallel",
    parameters,
    prepareArguments: canonicalArguments,
    async execute(_toolCallId, params, signal, onUpdate, ctx: ExtensionContext) {
      // Pi extension contexts are session-bound. Snapshot everything before the
      // first await so continuations cannot dereference a replaced session.
      const cwd = ctx.cwd;
      const projectTrusted = ctx.isProjectTrusted();
      const settings = SettingsManager.create(cwd, getAgentDir(), { projectTrusted });
      const defaultShell = getShellConfig(settings.getShellPath()).shell;
      const input = { ...params, defaultShell };
      return toolResult(
        await sessions.exec(input, cwd, signal, (update) =>
          onUpdate?.(toolResult(update, params.cmd)),
        ),
        params.cmd,
      );
    },
    renderCall(args, theme) {
      return new Text(`${theme.bold("Run")} ${args.cmd}`, 0, 0);
    },
    renderResult(result, { isPartial }, theme) {
      const details = result.details as UnifiedExecResult | undefined;
      if (isPartial || !details) return new Text(theme.fg("dim", "Running…"), 0, 0);
      const status =
        details.session_id === undefined
          ? `exit ${details.exit_code ?? "?"}`
          : `session ${details.session_id}`;
      return new Text(`${theme.bold("Run")} ${status}`, 0, 0);
    },
  };
}

export function registerExecCommandTool(pi: ExtensionAPI, sessions: ExecSessionManager): void {
  pi.registerTool(createExecCommandTool(sessions));
}
