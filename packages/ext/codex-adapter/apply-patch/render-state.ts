import { formatApplyPatchCollapsedDiff, renderApplyPatchCall } from "./rendering.js";

export interface ApplyPatchRenderSnapshot {
  collapsedDiff: string;
  expanded: string;
  status: "pending" | "partial_failure" | "failed";
  failedTargets?: string[] | undefined;
}

interface ApplyPatchRenderState extends ApplyPatchRenderSnapshot {
  cwd: string;
  patchText: string;
}

const applyPatchRenderStates = new Map<string, ApplyPatchRenderState>();

export function clearApplyPatchRenderState(): void {
  applyPatchRenderStates.clear();
}

export function setApplyPatchRenderState(toolCallId: string, patchText: string, cwd: string): void {
  applyPatchRenderStates.set(toolCallId, {
    cwd,
    patchText,
    collapsedDiff: formatApplyPatchCollapsedDiff(patchText, cwd),
    expanded: renderApplyPatchCall(patchText, cwd),
    status: "pending",
  });
}

export function markApplyPatchFailure(
  toolCallId: string,
  status: "partial_failure" | "failed",
  failedTargets?: string[],
): void {
  const existing = applyPatchRenderStates.get(toolCallId);
  if (existing) applyPatchRenderStates.set(toolCallId, { ...existing, status, failedTargets });
}

export function getApplyPatchRenderSnapshot(
  toolCallId: string,
): ApplyPatchRenderSnapshot | undefined {
  const state = applyPatchRenderStates.get(toolCallId);
  if (!state) return undefined;
  return {
    collapsedDiff: state.collapsedDiff,
    expanded: state.expanded,
    status: state.status,
    failedTargets: state.failedTargets,
  };
}

function markFailedTargetLine(line: string, failedTarget: string): string | undefined {
  const suffixMatch = line.match(/ \(\+\d+ -\d+\)$/);
  if (!suffixMatch) return undefined;
  const suffix = suffixMatch[0];
  const prefixAndTarget = line.slice(0, -suffix.length);
  const candidatePrefixes = [
    "• Edit partially failed ",
    "• Added ",
    "• Edited ",
    "• Deleted ",
    "  └ ",
    "    ",
  ];
  for (const prefix of candidatePrefixes) {
    if (prefixAndTarget === `${prefix}${failedTarget}`) {
      return `${prefix}${failedTarget} failed${suffix}`;
    }
  }
  return undefined;
}

function renderFailureCall(
  text: string,
  theme: { fg(role: string, text: string): string },
  status: "partial_failure" | "failed",
  failedTargets?: string[],
): string {
  const label = status === "partial_failure" ? "• Edit partially failed" : "• Edit failed";
  const headerRole = status === "partial_failure" ? "warning" : "error";
  const lines = text.split("\n");
  const firstLine = lines[0];
  if (firstLine === undefined) return theme.fg(headerRole, label);
  lines[0] = firstLine.replace(/^• (Added|Edited|Deleted)\b/, label);
  const failedLineIndexes = new Set<number>();
  if (failedTargets) {
    for (let index = 0; index < lines.length; index += 1) {
      for (const failedTarget of failedTargets) {
        const failedLine = markFailedTargetLine(lines[index] ?? "", failedTarget);
        if (failedLine) {
          lines[index] = failedLine;
          failedLineIndexes.add(index);
          break;
        }
      }
    }
  }
  return lines
    .map((line, index) => {
      if (failedLineIndexes.has(index)) return theme.fg("error", line);
      if (index === 0) return theme.fg(headerRole, line);
      return line;
    })
    .join("\n");
}

export function renderApplyPatchCallFromState(
  args: { input?: unknown },
  theme: { fg(role: string, text: string): string; bold(text: string): string },
  context?: {
    toolCallId?: string | undefined;
    cwd?: string | undefined;
    expanded?: boolean | undefined;
    argsComplete?: boolean | undefined;
    snapshot?: ApplyPatchRenderSnapshot | undefined;
  },
): string {
  if (context?.argsComplete === false) return `${theme.fg("dim", "•")} ${theme.bold("Patching")}`;
  const patchText = typeof args.input === "string" ? args.input : "";
  if (patchText.trim().length === 0) return `${theme.fg("dim", "•")} ${theme.bold("Patching")}`;

  const liveState = context?.toolCallId
    ? applyPatchRenderStates.get(context.toolCallId)
    : undefined;
  const cached = context?.snapshot ?? liveState;
  const cwd = context?.cwd ?? liveState?.cwd;
  const effectivePatchText = liveState?.patchText ?? patchText;
  const baseText = context?.expanded
    ? (cached?.expanded ?? renderApplyPatchCall(effectivePatchText, cwd))
    : (cached?.collapsedDiff ?? formatApplyPatchCollapsedDiff(effectivePatchText, cwd));

  if (baseText.trim().length === 0) {
    if (cached?.status === "failed") return theme.fg("error", "• Edit failed");
    return `${theme.fg("dim", "•")} ${theme.bold("Patching")}`;
  }
  if (cached?.status === "partial_failure" || cached?.status === "failed")
    return renderFailureCall(baseText, theme, cached.status, cached.failedTargets);
  return baseText;
}
