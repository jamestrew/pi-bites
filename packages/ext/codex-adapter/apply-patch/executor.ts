import { relative } from "node:path";
import { parsePatchActions } from "../patch/parser.js";
import { ExecutePatchError, type ExecutePatchResult } from "../patch/types.js";
import { getBundledApplyPatchBinaryPath } from "./binary.js";
import { parseSingleJsonLine, runBundledTool } from "../native/runner.js";

interface RustApplyPatchJson {
  status: "success" | "failure";
  error?: string | null | undefined;
  exact?: boolean | undefined;
  result: ExecutePatchResult;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isExecutePatchResult(value: unknown): value is ExecutePatchResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Record<string, unknown>;
  return (
    isStringArray(result["changedFiles"]) &&
    isStringArray(result["createdFiles"]) &&
    isStringArray(result["deletedFiles"]) &&
    isStringArray(result["movedFiles"]) &&
    typeof result["fuzz"] === "number" &&
    Number.isFinite(result["fuzz"])
  );
}

function parseRustApplyPatchJson(stdout: string): RustApplyPatchJson {
  const parsed = parseSingleJsonLine<unknown>(stdout, "apply_patch");
  if (!parsed || typeof parsed !== "object") {
    throw new Error("apply_patch returned invalid structured JSON output");
  }
  const value = parsed as Record<string, unknown>;
  const error = value["error"];
  if (
    (value["status"] !== "success" && value["status"] !== "failure") ||
    (error !== undefined && error !== null && typeof error !== "string") ||
    !isExecutePatchResult(value["result"])
  ) {
    throw new Error("apply_patch returned invalid structured JSON output");
  }
  return parsed as RustApplyPatchJson;
}

function displayPatchPath(cwd: string, path: string): string {
  if (!path.startsWith("/")) {
    return path;
  }
  const relativePath = relative(cwd, path);
  return relativePath && !relativePath.startsWith("..") && !relativePath.startsWith("/")
    ? relativePath
    : path;
}

function actionMentionLength(
  error: string,
  action: { path: string; movePath?: string | undefined },
): number {
  return Math.max(
    error.includes(action.path) ? action.path.length : -1,
    action.movePath && error.includes(action.movePath) ? action.movePath.length : -1,
  );
}

function collapseDuplicatedError(message: string): string {
  const separator = ": ";
  const halfLength = (message.length - separator.length) / 2;
  if (!Number.isInteger(halfLength) || halfLength <= 0) return message;
  const first = message.slice(0, halfLength);
  return message.slice(halfLength, halfLength + separator.length) === separator &&
    message.slice(halfLength + separator.length) === first
    ? first
    : message;
}

export async function executePatchWithRust({
  cwd,
  patchText,
  signal,
  binaryPath,
}: {
  cwd: string;
  patchText: string;
  signal?: AbortSignal | undefined;
  binaryPath?: string | undefined;
}): Promise<ExecutePatchResult> {
  const binary = binaryPath ?? getBundledApplyPatchBinaryPath();
  if (!binary) {
    throw new Error(`apply_patch binary is not bundled for ${process.platform}-${process.arch}`);
  }
  const child = await runBundledTool({
    binary,
    args: [],
    stdin: patchText,
    cwd,
    env: { ...process.env, PI_APPLY_PATCH_JSON: "1" },
    signal,
    label: "apply_patch",
  });
  let parsed: RustApplyPatchJson;
  try {
    parsed = parseRustApplyPatchJson(child.stdout);
  } catch (error) {
    if (child.status !== 0 || child.signal || child.stderr) {
      const termination = child.signal
        ? `signal ${child.signal}`
        : `status ${String(child.status)}`;
      const detail =
        child.stderr.trim() || (error instanceof Error ? error.message : String(error));
      throw new Error(`apply_patch exited with ${termination}: ${detail}`);
    }
    throw error;
  }
  if (parsed.status === "success" && child.status === 0) {
    return parsed.result;
  }

  const result = parsed.result;
  const errorMessage = collapseDuplicatedError(
    parsed.error ?? (child.stderr || "apply_patch failed"),
  );
  let parsedActions = [] as ReturnType<typeof parsePatchActions>;
  try {
    parsedActions = parsePatchActions({ text: patchText }).map((action) => ({
      ...action,
      path: displayPatchPath(cwd, action.path),
      movePath: action.movePath ? displayPatchPath(cwd, action.movePath) : action.movePath,
    }));
  } catch {
    // Rust already produced the authoritative parse error.
  }
  const failure = parsedActions
    .map((action) => ({ action, mentionLength: actionMentionLength(errorMessage, action) }))
    .sort((left, right) => right.mentionLength - left.mentionLength)[0];
  const failures =
    failure && failure.mentionLength >= 0
      ? [{ action: failure.action, message: errorMessage }]
      : [];
  throw new ExecutePatchError(errorMessage, result, failures);
}
