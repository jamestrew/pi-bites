import { realpath } from "node:fs/promises";
import { Container, Text } from "@earendil-works/pi-tui";
import {
  type AgentToolResult,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { parsePatchActions } from "../patch/parser.js";
import { resolvePatchPath } from "../patch/paths.js";
import { ExecutePatchError, type ExecutePatchResult } from "../patch/types.js";
import { executePatchWithRust } from "./executor.js";
import {
  clearApplyPatchRenderState,
  getApplyPatchRenderSnapshot,
  markApplyPatchFailure,
  renderApplyPatchCallFromState,
  setApplyPatchRenderState,
  type ApplyPatchRenderSnapshot,
} from "./render-state.js";
import { formatPatchTarget } from "./rendering.js";

const parameters = Type.Object({
  input: Type.String({
    description: "The complete patch using the *** Begin Patch / *** End Patch format.",
  }),
});

export interface ApplyPatchDetails {
  status: "success" | "partial_failure";
  result: ExecutePatchResult;
  render: ApplyPatchRenderSnapshot;
  failedTargets?: string[];
}

interface ApplyPatchToolRenderState {
  snapshot?: ApplyPatchRenderSnapshot;
}

export interface CreateApplyPatchToolOptions {
  binaryPath?: string;
}

function summarizePatchCounts(result: ExecutePatchResult): string {
  return [
    `changed ${result.changedFiles.length} file${result.changedFiles.length === 1 ? "" : "s"}`,
    `created ${result.createdFiles.length}`,
    `deleted ${result.deletedFiles.length}`,
    `moved ${result.movedFiles.length}`,
  ].join(", ");
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function failedTargets(error: ExecutePatchError): string[] {
  return uniqueStrings(
    error.failures.flatMap(({ action }) => [
      action.path,
      action.type === "update" ? action.movePath : undefined,
    ]),
  );
}

function failedPatchTargets(error: ExecutePatchError, cwd: string): string[] {
  return uniqueStrings(
    error.failures.map(({ action }) =>
      formatPatchTarget(action.path, action.type === "update" ? action.movePath : undefined, cwd),
    ),
  );
}

function partialFailureMessage(error: ExecutePatchError, targets: string[]): string {
  const targetSummary = targets.length > 0 ? ` while patching ${targets.join(", ")}` : "";
  const lines = [
    `apply_patch partially failed after ${summarizePatchCounts(error.result)}${targetSummary}: ${error.message}`,
  ];
  if (targets.length > 0) {
    lines.push(`Failed file${targets.length === 1 ? "" : "s"}: ${targets.join(", ")}`);
    lines.push(`Recovery: MUST read ${targets.join(", ")} before retrying`);
  }
  const applied = error.result.changedFiles.filter((path) => !targets.includes(path));
  if (applied.length > 0) {
    lines.push("Earlier file actions in this patch were already applied");
    lines.push(
      "Recovery: MUST NOT reread other files from this patch unless a specific dependency requires it",
    );
  }
  return lines.join("\n");
}

function renderSnapshot(toolCallId: string): ApplyPatchRenderSnapshot {
  const snapshot = getApplyPatchRenderSnapshot(toolCallId);
  if (!snapshot) throw new Error(`Missing apply_patch render state for ${toolCallId}`);
  return snapshot;
}

function successMessage(result: ExecutePatchResult): string {
  return [
    "Applied patch successfully",
    `Changed files: ${result.changedFiles.length}`,
    `Created files: ${result.createdFiles.length}`,
    `Deleted files: ${result.deletedFiles.length}`,
    `Moved files: ${result.movedFiles.length}`,
    `Fuzz: ${result.fuzz}`,
  ].join("\n");
}

function touchedPatchPaths(cwd: string, patchText: string): string[] {
  try {
    return [
      ...new Set(
        parsePatchActions({ text: patchText }).flatMap((action) =>
          [action.path, action.movePath]
            .filter((path): path is string => typeof path === "string")
            .map((patchPath) => resolvePatchPath({ cwd, patchPath })),
        ),
      ),
    ];
  } catch {
    return [];
  }
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

async function canonicalMutationPaths(paths: string[]): Promise<string[]> {
  const canonical = await Promise.all(
    paths.map(async (path) => {
      try {
        return await realpath(path);
      } catch (error) {
        if (isMissingPathError(error)) return path;
        throw error;
      }
    }),
  );
  return [...new Set(canonical)].sort();
}

async function withMutationQueues<T>(paths: string[], run: () => Promise<T>): Promise<T> {
  const uniquePaths = await canonicalMutationPaths(paths);
  const acquire = (index: number): Promise<T> => {
    const path = uniquePaths[index];
    return path === undefined ? run() : withFileMutationQueue(path, () => acquire(index + 1));
  };
  return acquire(0);
}

export function createApplyPatchTool(
  options: CreateApplyPatchToolOptions = {},
): ToolDefinition<typeof parameters, ApplyPatchDetails, ApplyPatchToolRenderState> {
  return {
    name: "apply_patch",
    label: "apply_patch",
    description:
      "Apply a patch to files. Supports adding, updating, moving, and deleting files in one operation.",
    promptSnippet: "Edit files with patch",
    executionMode: "sequential",
    parameters,
    prepareArguments(args: unknown) {
      if (args && typeof args === "object") {
        if ("input" in args && typeof args.input === "string") return { input: args.input };
        if ("patchText" in args && typeof args.patchText === "string")
          return { input: args.patchText };
        if ("patch" in args && typeof args.patch === "string") return { input: args.patch };
      }
      return args as { input: string };
    },
    async execute(
      toolCallId: string,
      params: { input: string },
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<ApplyPatchDetails>> {
      const cwd = ctx.cwd;
      const patchText = params.input;
      setApplyPatchRenderState(toolCallId, patchText, cwd);
      const initialRender = renderSnapshot(toolCallId);
      if (signal?.aborted) {
        markApplyPatchFailure(toolCallId, "failed");
        throw new Error("apply_patch aborted");
      }
      const touchedPaths = touchedPatchPaths(cwd, patchText);
      try {
        const result = await withMutationQueues(touchedPaths, () =>
          executePatchWithRust({ cwd, patchText, signal, binaryPath: options.binaryPath }),
        );
        return {
          content: [{ type: "text", text: successMessage(result) }],
          details: { status: "success", result, render: initialRender },
        };
      } catch (error) {
        if (signal?.aborted) {
          markApplyPatchFailure(toolCallId, "failed");
          const targets = touchedPaths.length > 0 ? touchedPaths.join(", ") : "the patch targets";
          throw new Error(
            `apply_patch aborted after the native process stopped; changes may have partially applied. Inspect before retrying: ${targets}`,
          );
        }
        if (!(error instanceof ExecutePatchError)) {
          markApplyPatchFailure(toolCallId, "failed");
          throw error;
        }
        const targets = failedTargets(error);
        const renderTargets = failedPatchTargets(error, cwd);
        if (!error.hasPartialSuccess()) {
          markApplyPatchFailure(toolCallId, "failed", renderTargets);
          const targetSummary = targets.length > 0 ? ` while patching ${targets.join(", ")}` : "";
          throw new Error(`apply_patch failed${targetSummary}: ${error.message}`);
        }
        markApplyPatchFailure(toolCallId, "partial_failure", renderTargets);
        const text = partialFailureMessage(error, targets);
        return {
          content: [{ type: "text", text }],
          details: {
            status: "partial_failure",
            result: error.result,
            render: {
              ...initialRender,
              status: "partial_failure",
              failedTargets: renderTargets,
            },
            ...(targets.length > 0 ? { failedTargets: targets } : {}),
          },
        };
      }
    },
    renderCall(args, theme, context) {
      return new Text(
        renderApplyPatchCallFromState(args, theme, {
          ...context,
          snapshot: context.state.snapshot,
        }),
        0,
        0,
      );
    },
    renderResult(result, { isPartial }, theme, context) {
      if (isPartial) return new Container();
      const snapshot = (result.details as Partial<ApplyPatchDetails> | undefined)?.render;
      if (snapshot && context.state.snapshot !== snapshot) {
        context.state.snapshot = snapshot;
        context.invalidate();
      }
      return new Container();
    },
  };
}

export function registerApplyPatchTool(pi: ExtensionAPI): void {
  pi.registerTool(createApplyPatchTool());
  pi.on("session_start", clearApplyPatchRenderState);
  pi.on("session_shutdown", clearApplyPatchRenderState);
  pi.on("tool_result", (event) => {
    if (
      event.toolName === "apply_patch" &&
      event.details &&
      typeof event.details === "object" &&
      "status" in event.details &&
      event.details.status === "partial_failure"
    ) {
      return { isError: true };
    }
    return undefined;
  });
}
