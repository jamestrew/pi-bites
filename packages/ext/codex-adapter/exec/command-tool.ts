import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { basename, dirname } from "node:path";
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
import { extractBashFacts, type BashSimpleCommand } from "../../bash-gate/bash-command-facts.js";
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
  return theme.bold(action) + (detail ? theme.fg("toolTitle", detail) : "");
}

function textContent(result: AgentToolResult<UnifiedExecResult>): string {
  return result.content
    .filter((item): item is { type: "text"; text: string } => item.type === "text")
    .map(({ text }) => text)
    .join("\n");
}

function modelInputTokenCount(result: AgentToolResult<UnifiedExecResult>): number {
  return Math.ceil(textContent(result).length / 4);
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
  const inputTokens = modelInputTokenCount(result);
  const tokenSuffix =
    inputTokens > 0 ? ` · ~${inputTokens.toLocaleString("en-US")} input tokens` : "";
  if (details?.session_id !== undefined)
    return `Running in session ${details.session_id} · ${details.wall_time_seconds.toFixed(1)}s${tokenSuffix}`;
  const seconds =
    details?.wall_time_seconds ??
    (startedAt === undefined ? undefined : ((endedAt ?? Date.now()) - startedAt) / 1000);
  return seconds === undefined || (!details && !isError)
    ? undefined
    : `Took ${seconds.toFixed(1)}s${tokenSuffix}`;
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
  cmd: Type.String({
    description:
      "Raw command string interpreted by the current shell; do not quote the entire command.",
  }),
  workdir: Type.Optional(
    Type.String({ description: "Working directory, relative to the session cwd or absolute." }),
  ),
  shell: Type.Optional(
    Type.String({ description: "Shell executable. Defaults to Pi's configured shell." }),
  ),
  tty: Type.Optional(Type.Boolean({ description: "Run in an interactive pseudo-terminal." })),
  yield_time_ms: Type.Optional(
    Type.Number({
      description:
        "Wait before yielding output. Defaults to 30000 ms; minimum 5000 ms for non-interactive commands.",
    }),
  ),
  max_output_tokens: Type.Optional(
    Type.Number({ description: "Output token budget. Defaults to 10000 tokens." }),
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

function catOperandIndexes(argv: string[]): number[] {
  const operands: number[] = [];
  let options = true;
  for (let index = 1; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (options && arg === "--") {
      options = false;
    } else if (!options || !arg.startsWith("-")) {
      operands.push(index);
    }
  }
  return operands;
}

function sedOperandIndexes(argv: string[]): number[] {
  const operands: number[] = [];
  let hasScript = false;
  let quiet = false;
  let options = true;

  for (let index = 1; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (options && arg === "--") {
      options = false;
      continue;
    }
    if (options && arg.startsWith("--")) {
      if (arg === "--quiet" || arg === "--silent") quiet = true;
      else if (arg === "--expression" || arg === "--file" || arg === "--line-length") {
        if (arg !== "--line-length") hasScript = true;
        index++;
      } else if (arg.startsWith("--expression=") || arg.startsWith("--file=")) {
        hasScript = true;
      } else if (arg === "--in-place" || arg.startsWith("--in-place=")) {
        return [];
      }
      continue;
    }
    if (options && arg.startsWith("-") && arg !== "-") {
      const flags = arg.slice(1);
      for (let offset = 0; offset < flags.length; offset++) {
        const flag = flags[offset];
        if (flag === "n") quiet = true;
        else if (flag === "e" || flag === "f") {
          hasScript = true;
          if (offset + 1 === flags.length) index++;
          break;
        } else if (flag === "i") {
          return [];
        } else if (flag === "l") {
          if (offset + 1 === flags.length) index++;
          break;
        }
      }
      continue;
    }
    if (!hasScript) {
      hasScript = true;
    } else {
      operands.push(index);
    }
  }
  return quiet ? operands : [];
}

function skillOperands(command: BashSimpleCommand): string[] {
  let indexes: number[] = [];
  if (command.name === "cat") indexes = catOperandIndexes(command.argv);
  else if (command.name === "sed") indexes = sedOperandIndexes(command.argv);
  const dynamic = new Set(command.dynamicArgIndexes ?? []);
  return indexes.flatMap((index) => {
    const operand = command.argv[index];
    return operand === undefined || dynamic.has(index) ? [] : [operand];
  });
}

async function skillNames(
  command: string,
  analyzeCommand: typeof extractBashFacts,
): Promise<string[]> {
  const facts = await analyzeCommand(command);
  const names = facts.commands.flatMap(skillOperands).flatMap((path) => {
    if (basename(path) !== "SKILL.md") return [];
    const name = basename(dirname(path));
    return name && name !== "." ? [name] : [];
  });
  return [...new Set(names)];
}

export function createExecCommandTool(
  sessions: ExecSessionManager,
  analyzeCommand: typeof extractBashFacts = extractBashFacts,
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
      const ui = ctx.hasUI ? ctx.ui : undefined;
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
      if (ui) {
        void skillNames(displayCommand, analyzeCommand)
          .then((names) => {
            if (names.length) ui.notify(`[skill] ${names.join(", ")}`, "info");
          })
          .catch(() => {
            // Skill classification is display-only; command execution must fail open.
          });
      }
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
