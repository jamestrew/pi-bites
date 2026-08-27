/** Persistent, payload-free diagnostics for reconstructing subagent failures. */

import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type SubagentDiagnosticRecord = {
  type: "subagent_diagnostic";
  version: 1;
  timestamp: number;
  event: string;
  agentId: string;
  parentSessionId: string;
  subagent: string;
  pid: number;
  provider?: string;
  model?: string;
  thinking?: string;
  details?: Record<string, unknown>;
};

let writeQueue: Promise<void> = Promise.resolve();

export interface DiagnosticErrorInfo {
  name?: string;
  message: string;
  stack?: string;
  code?: string | number;
  cause?: DiagnosticErrorInfo;
}

/** Preserve normal Error cause chains without assuming every thrown value is an Error. */
export function serializeDiagnosticError(error: unknown, depth = 0): DiagnosticErrorInfo {
  if (!(error instanceof Error)) return { message: String(error) };
  const code = (error as Error & { code?: unknown }).code;
  const cause = (error as Error & { cause?: unknown }).cause;
  return {
    name: error.name,
    message: error.message,
    ...(error.stack ? { stack: error.stack } : {}),
    ...(typeof code === "string" || typeof code === "number" ? { code } : {}),
    ...(cause !== undefined && depth < 8
      ? { cause: serializeDiagnosticError(cause, depth + 1) }
      : {}),
  };
}

function stringifyDiagnostic(record: SubagentDiagnosticRecord): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(record, (_key, value: unknown) => {
    if (typeof value === "bigint") return value.toString();
    if (value instanceof Error) return serializeDiagnosticError(value);
    if (typeof value === "object" && value !== null) {
      if (seen.has(value)) return "[Circular]";
      seen.add(value);
    }
    return value;
  });
}

function getAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

export function getSubagentDiagnosticsFile(): string {
  return join(getAgentDir(), "pi-bites", "diagnostics", "subagents.jsonl");
}

/**
 * Serialize appends so events from concurrent callbacks remain in observation order.
 * A failed write does not poison later writes.
 */
export function appendSubagentDiagnostic(record: SubagentDiagnosticRecord): Promise<void> {
  // Tests that need persistence opt in with an isolated PI_CODING_AGENT_DIR.
  if (process.env.VITEST && !process.env.PI_CODING_AGENT_DIR) return Promise.resolve();
  const file = getSubagentDiagnosticsFile();
  const write = async () => {
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, stringifyDiagnostic(record) + "\n", "utf8");
  };
  const result = writeQueue.then(write, write);
  writeQueue = result.catch(() => undefined);
  return result;
}
