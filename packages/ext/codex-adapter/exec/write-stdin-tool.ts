import { Text } from "@earendil-works/pi-tui";
import type {
  AgentToolResult,
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { formatUnifiedExecResult } from "./format.js";
import type { ExecSessionManager, UnifiedExecResult, WriteStdinInput } from "./session-manager.js";

const parameters = Type.Object({
  session_id: Type.Number({ description: "Session identifier returned by exec_command." }),
  chars: Type.Optional(
    Type.String({ description: "Characters to write. Omit to poll for output." }),
  ),
  yield_time_ms: Type.Optional(Type.Number({ description: "Wait time for output or completion." })),
  max_output_tokens: Type.Optional(
    Type.Number({ description: "Maximum approximate output tokens returned." }),
  ),
});

function canonicalArguments(args: unknown): WriteStdinInput {
  if (!args || typeof args !== "object") return args as WriteStdinInput;
  const value = args as Record<string, unknown>;
  return {
    session_id: (value.session_id ?? value.sessionId ?? value.process_id) as number,
    ...(typeof (value.chars ?? value.input) === "string"
      ? { chars: (value.chars ?? value.input) as string }
      : {}),
    ...(typeof (value.yield_time_ms ?? value.yield_time) === "number"
      ? { yield_time_ms: (value.yield_time_ms ?? value.yield_time) as number }
      : {}),
    ...(typeof value.max_output_tokens === "number"
      ? { max_output_tokens: value.max_output_tokens }
      : {}),
  };
}

function toolResult(
  result: UnifiedExecResult,
  command?: string,
): AgentToolResult<UnifiedExecResult> {
  return {
    content: [{ type: "text", text: formatUnifiedExecResult(result, command) }],
    details: result,
  };
}

export function createWriteStdinTool(
  sessions: ExecSessionManager,
): ToolDefinition<typeof parameters, UnifiedExecResult> {
  return {
    name: "write_stdin",
    label: "write_stdin",
    description: "Write characters to or poll a running exec_command session.",
    promptSnippet: "Resume or interact with shell sessions",
    executionMode: "parallel",
    parameters,
    prepareArguments: canonicalArguments,
    async execute(_toolCallId, params, signal, onUpdate) {
      const command = sessions.getSessionCommand(params.session_id);
      return toolResult(
        await sessions.write(params, signal, (update) => onUpdate?.(toolResult(update, command))),
        command,
      );
    },
    renderCall(args, theme) {
      return new Text(
        `${theme.bold(args.chars === undefined ? "Poll" : "Input")} session ${args.session_id}`,
        0,
        0,
      );
    },
    renderResult(result, { isPartial }, theme) {
      const details = result.details as UnifiedExecResult | undefined;
      if (isPartial || !details) return new Text(theme.fg("dim", "Waiting…"), 0, 0);
      const status =
        details.session_id === undefined ? `exit ${details.exit_code ?? "?"}` : "running";
      return new Text(`${theme.bold("Session")} ${status}`, 0, 0);
    },
  };
}

export function registerWriteStdinTool(pi: ExtensionAPI, sessions: ExecSessionManager): void {
  pi.registerTool(createWriteStdinTool(sessions));
}
