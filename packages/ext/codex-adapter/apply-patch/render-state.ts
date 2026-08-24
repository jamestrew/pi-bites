import {
  formatApplyPatchCollapsedDiff,
  formatPatchTarget,
  renderApplyPatchCall,
} from "./rendering.js";

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
  const candidatePrefixes = ["Add ", "Delete ", "Edit ", "→ "];
  for (const prefix of candidatePrefixes) {
    if (prefixAndTarget === `${prefix}${failedTarget}`) {
      return `${prefix}${failedTarget} failed${suffix}`;
    }
  }
  return undefined;
}

function styleFileHeaderLine(
  line: string,
  theme: { fg(role: string, text: string): string },
): string {
  const match = line.match(/^(→ .*?)( failed)? \(\+(\d+) -(\d+)\)$/);
  if (!match) return line;
  const [, target, failure, added, removed] = match;
  return (
    theme.fg("dim", target ?? "") +
    (failure ? theme.fg("dim", failure) : "") +
    theme.fg("dim", " (") +
    theme.fg("toolDiffAdded", `+${added}`) +
    theme.fg("dim", " ") +
    theme.fg("toolDiffRemoved", `-${removed}`) +
    theme.fg("dim", ")")
  );
}

function styleScanline(
  line: string,
  theme: { fg(role: string, text: string): string; bold(text: string): string },
): string {
  const match = line.match(/^(Add|Edit|Delete)(.*)$/);
  if (!match) return theme.bold("Edit") + (line ? theme.fg("accent", ` ${line}`) : "");
  return theme.bold(match[1] ?? "Edit") + theme.fg("accent", match[2] ?? "");
}

function stylePatchCall(
  text: string,
  theme: { fg(role: string, text: string): string; bold(text: string): string },
): string {
  return text
    .split("\n")
    .map((line, index) => {
      if (index === 0) return styleScanline(line, theme);
      if (line.startsWith("... (")) return theme.fg("dim", line);
      return styleFileHeaderLine(line, theme);
    })
    .join("\n");
}

function renderPendingCall(
  patchText: string,
  cwd: string | undefined,
  theme: { fg(role: string, text: string): string; bold(text: string): string },
): string {
  const files: { action: "Add" | "Delete" | "Edit"; path: string; movePath?: string }[] = [];
  for (const line of patchText.split("\n")) {
    const header = line.match(/^\*\*\* (Add|Update|Delete) File: (.+)$/);
    if (header?.[2]) {
      const action = header[1] === "Add" ? "Add" : header[1] === "Delete" ? "Delete" : "Edit";
      files.push({ action, path: header[2] });
      continue;
    }
    const movePath = line.match(/^\*\*\* Move to: (.+)$/)?.[1];
    const current = files.at(-1);
    if (movePath && current?.action === "Edit") current.movePath = movePath;
  }
  const file = files[0];
  if (!file) return styleScanline("", theme);
  if (files.length > 1) return styleScanline(`Edit ${files.length} targets`, theme);
  return styleScanline(
    `${file.action} ${formatPatchTarget(file.path, file.movePath, cwd ?? process.cwd())}`,
    theme,
  );
}

function renderFailureCall(
  text: string,
  theme: { fg(role: string, text: string): string; bold(text: string): string },
  status: "partial_failure" | "failed",
  failedTargets?: string[],
): string {
  const label = status === "partial_failure" ? "partially failed" : "failed";
  const lines = text.split("\n");
  const firstLine = lines[0];
  if (firstLine === undefined) return styleScanline(`Edit ${label}`, theme);
  lines[0] = firstLine.replace(/^(Add|Delete|Edit)\b/, `$1 ${label}`);
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
      if (failedLineIndexes.has(index))
        return line.startsWith("→ ")
          ? styleFileHeaderLine(line, theme)
          : styleScanline(line, theme);
      if (index === 0) return styleScanline(line, theme);
      if (line.startsWith("... (")) return theme.fg("dim", line);
      return styleFileHeaderLine(line, theme);
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
    isError?: boolean | undefined;
    snapshot?: ApplyPatchRenderSnapshot | undefined;
  },
): string {
  const patchText = typeof args.input === "string" ? args.input : "";
  if (context?.argsComplete === false) return renderPendingCall(patchText, context.cwd, theme);
  if (patchText.trim().length === 0) return theme.bold("Edit");

  const liveState = context?.toolCallId
    ? applyPatchRenderStates.get(context.toolCallId)
    : undefined;
  const cached = context?.snapshot ?? liveState;
  const cwd = context?.cwd ?? liveState?.cwd;
  const effectivePatchText = liveState?.patchText ?? patchText;
  const status =
    cached?.status === "partial_failure" || cached?.status === "failed"
      ? cached.status
      : context?.isError
        ? "failed"
        : cached?.status;
  const baseText = context?.expanded
    ? (cached?.expanded ?? renderApplyPatchCall(effectivePatchText, cwd))
    : (cached?.collapsedDiff ?? formatApplyPatchCollapsedDiff(effectivePatchText, cwd));

  if (baseText.trim().length === 0) {
    if (status === "failed") return styleScanline("Edit failed", theme);
    return styleScanline("", theme);
  }
  if (status === "partial_failure" || status === "failed")
    return renderFailureCall(baseText, theme, status, cached?.failedTargets);
  return stylePatchCall(baseText, theme);
}
