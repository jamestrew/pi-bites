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

import { sanitizeText } from "../../subagents/ui/text-lines.js";
import { consumeRtkExecInput } from "../../rtk.js";
import { formatUnifiedExecResult } from "./format.js";
import type { ExecSessionManager, UnifiedExecResult } from "./session-manager.js";

const COLLAPSED_OUTPUT_LINES = 5;

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

export function renderExecScanline(
  action: string,
  command: unknown,
  suffix: string,
  theme: RenderTheme,
): string {
  const summary = typeof command === "string" ? sanitizeText(command).trim() : "";
  const detail = `${summary ? ` ${summary}` : ""}${suffix}`;
  return theme.bold(action) + (detail ? theme.fg("accent", detail) : "");
}

function textContent(result: AgentToolResult<UnifiedExecResult>): string {
  return result.content
    .filter((item): item is { type: "text"; text: string } => item.type === "text")
    .map(({ text }) => text)
    .join("\n");
}

function execOutput(result: AgentToolResult<UnifiedExecResult>): string {
  const details = result.details as UnifiedExecResult | undefined;
  return sanitizeText(details?.output ?? textContent(result))
    .replace(/^(?:[\t ]*\n)+/, "")
    .replace(/[\t ]*(?:\n[\t ]*)+$/, "");
}

function execStatus(
  result: AgentToolResult<UnifiedExecResult>,
  isPartial: boolean,
  isError: boolean,
  startedAt?: number,
  endedAt?: number,
): string | undefined {
  const details = result.details as UnifiedExecResult | undefined;
  if (isPartial) return details ? `Elapsed ${details.wall_time_seconds.toFixed(1)}s` : undefined;
  if (details?.session_id !== undefined)
    return `Running in session ${details.session_id} · ${details.wall_time_seconds.toFixed(1)}s`;
  const seconds =
    details?.wall_time_seconds ??
    (startedAt === undefined ? undefined : ((endedAt ?? Date.now()) - startedAt) / 1000);
  return seconds === undefined || (!details && !isError)
    ? undefined
    : `Took ${seconds.toFixed(1)}s`;
}

export function throwForExecFailure(result: UnifiedExecResult): void {
  if (result.exit_code === undefined || result.exit_code === 0) return;
  throw new Error(
    `${result.output ? `${result.output}\n\n` : ""}Command exited with code ${result.exit_code}`,
  );
}

export function renderExecResult(
  result: AgentToolResult<UnifiedExecResult>,
  options: { expanded: boolean; isPartial: boolean },
  theme: RenderTheme,
  context: { isError: boolean; state: { startedAt?: number; endedAt?: number } },
) {
  if (!options.isPartial || context.isError) context.state.endedAt ??= Date.now();
  const output = execOutput(result);
  const outputText = new Text(
    output
      .split("\n")
      .map((line) => theme.fg("dim", line))
      .join("\n"),
    0,
    0,
  );
  const status = execStatus(
    result,
    options.isPartial,
    context.isError,
    context.state.startedAt,
    context.state.endedAt,
  );
  const statusText = status ? new Text(theme.fg("dim", status), 0, 0) : undefined;
  return {
    render(width: number) {
      const lines = output ? outputText.render(width) : [];
      const visible = options.expanded ? lines : lines.slice(-COLLAPSED_OUTPUT_LINES);
      const hidden = lines.length - visible.length;
      const rendered: string[] = [...visible];
      if (statusText) {
        if (rendered.length) rendered.push("");
        rendered.push(...statusText.render(width));
      }
      if (hidden > 0) {
        const hint =
          theme.fg("dim", `... (${hidden} earlier lines, `) + expandHint() + theme.fg("dim", ")");
        rendered.push(truncateToWidth(hint, width, "…"));
      }
      return rendered.length ? ["", ...rendered] : rendered;
    },
    invalidate() {
      outputText.invalidate();
      statusText?.invalidate();
    },
  };
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
    ...value,
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
): ToolDefinition<typeof parameters, UnifiedExecResult, { startedAt?: number; endedAt?: number }> {
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
      const originalCommand = consumeRtkExecInput(params);
      const displayCommand = originalCommand ?? params.cmd;
      const input = {
        ...params,
        defaultShell,
        displayCommand,
        filterRtkOutput: originalCommand !== undefined,
      };
      const result = await sessions.exec(input, cwd, signal, (update) =>
        onUpdate?.(toolResult(update, displayCommand)),
      );
      throwForExecFailure(result);
      return toolResult(result, displayCommand);
    },
    renderCall(args, theme, context) {
      if (context.executionStarted) context.state.startedAt ??= Date.now();
      return new Text(
        renderExecScanline("Exec", args.cmd, args.tty === true ? " (TTY)" : "", theme),
        0,
        0,
      );
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      return renderExecResult(result, { expanded, isPartial }, theme, context);
    },
  };
}

export function registerExecCommandTool(pi: ExtensionAPI, sessions: ExecSessionManager): void {
  pi.registerTool(createExecCommandTool(sessions));
}
