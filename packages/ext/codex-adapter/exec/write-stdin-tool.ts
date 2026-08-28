import { Text } from "@earendil-works/pi-tui";
import type {
  AgentToolResult,
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { formatUnifiedExecResult } from "./format.js";
import { renderExecResult, renderExecScanline, throwForExecFailure } from "./command-tool.js";
import type { ExecSessionManager, UnifiedExecResult, WriteStdinInput } from "./session-manager.js";

const parameters = Type.Object({
  session_id: Type.Number({ description: "Session identifier returned by exec_command." }),
  chars: Type.Optional(
    Type.String({
      description: "Characters to write. Omit or pass empty to poll without writing.",
    }),
  ),
  yield_time_ms: Type.Optional(
    Type.Number({
      description:
        "Wait before yielding output. Non-empty writes default to 250 ms; empty polls default to 30000 ms.",
    }),
  ),
  max_output_tokens: Type.Optional(
    Type.Number({ description: "Output token budget. Defaults to 10000 tokens." }),
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
): ToolDefinition<typeof parameters, UnifiedExecResult, { startedAt?: number; endedAt?: number }> {
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
      const result = await sessions.write(params, signal, (update) =>
        onUpdate?.(toolResult(update, command)),
      );
      throwForExecFailure(result);
      return toolResult(result, command);
    },
    renderCall(args, theme, context) {
      if (context.executionStarted) context.state.startedAt ??= Date.now();
      const command = sessions.getSessionCommand(args.session_id);
      return new Text(
        renderExecScanline(
          args.chars?.length ? "Input" : "Poll",
          command ?? `session ${args.session_id}`,
          "",
          theme,
        ),
        0,
        0,
      );
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      return renderExecResult(result, { expanded, isPartial }, theme, context);
    },
  };
}

export function registerWriteStdinTool(pi: ExtensionAPI, sessions: ExecSessionManager): void {
  pi.registerTool(createWriteStdinTool(sessions));
}
