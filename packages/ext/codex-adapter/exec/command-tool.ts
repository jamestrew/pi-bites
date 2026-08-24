import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import {
  getAgentDir,
  getShellConfig,
  keyHint,
  SettingsManager,
  type AgentToolResult,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

import { sanitizeSingleLine, sanitizeText } from "../../subagents/ui/text-lines.js";
import { formatUnifiedExecResult } from "./format.js";
import type { ExecSessionManager, UnifiedExecResult } from "./session-manager.js";

const COLLAPSED_DETAIL_LINES = 8;

interface RenderTheme {
  bold(text: string): string;
  fg(role: string, text: string): string;
}

function expandHint(): string {
  try {
    return keyHint("app.tools.expand", "to expand");
  } catch {
    return "ctrl+o to expand";
  }
}

function renderExecScanline(command: unknown, theme: RenderTheme): string {
  const summary = typeof command === "string" ? sanitizeSingleLine(command).trim() : "";
  return theme.bold("exec_command") + (summary ? theme.fg("accent", ` ${summary}`) : "");
}

function textContent(result: AgentToolResult<UnifiedExecResult>): string {
  return result.content
    .filter((item): item is { type: "text"; text: string } => item.type === "text")
    .map(({ text }) => text)
    .join("\n");
}

function execDetails(result: AgentToolResult<UnifiedExecResult>, isPartial: boolean): string[] {
  const details = result.details as UnifiedExecResult | undefined;
  const status = details
    ? isPartial
      ? "running"
      : details.session_id === undefined
        ? `exit ${details.exit_code ?? "?"} · ${details.wall_time_seconds.toFixed(2)}s`
        : `session ${details.session_id} running · ${details.wall_time_seconds.toFixed(2)}s`
    : isPartial
      ? "running"
      : "failed";
  const output = sanitizeText(details?.output ?? textContent(result));
  return [status, ...(output ? output.split("\n") : [])];
}

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
      const scanline = renderExecScanline(args.cmd, theme);
      return {
        render: (width) => [truncateToWidth(scanline, width, "…")],
        invalidate() {},
      };
    },
    renderResult(result, { expanded, isPartial }, theme) {
      const text = new Text(
        execDetails(result, isPartial)
          .map((line) => theme.fg("dim", line))
          .join("\n"),
        0,
        0,
      );
      return {
        render(width) {
          const lines = text.render(width);
          if (expanded || lines.length <= COLLAPSED_DETAIL_LINES) return ["", ...lines];
          const hidden = lines.length - COLLAPSED_DETAIL_LINES;
          const hint = theme.fg("dim", `... (${hidden} more lines, ${expandHint()})`);
          return ["", ...lines.slice(0, COLLAPSED_DETAIL_LINES), truncateToWidth(hint, width, "…")];
        },
        invalidate: () => text.invalidate(),
      };
    },
  };
}

export function registerExecCommandTool(pi: ExtensionAPI, sessions: ExecSessionManager): void {
  pi.registerTool(createExecCommandTool(sessions));
}
