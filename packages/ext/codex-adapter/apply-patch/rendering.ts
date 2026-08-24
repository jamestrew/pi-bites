import { isAbsolute, relative } from "node:path";
import { keyHint, renderDiff } from "@earendil-works/pi-coding-agent";

import { sanitizeSingleLine, sanitizeText } from "../../subagents/ui/text-lines.js";
import { openFileAtPath } from "../patch/paths.js";
import { parsePatchActions } from "../patch/parser.js";
import type { ParsedPatchAction } from "../patch/types.js";

interface PreviewLine {
  lineNumber: number;
  marker: " " | "+" | "-";
  text: string;
}

interface FilePreview {
  verb: "Add" | "Delete" | "Edit";
  path: string;
  movePath?: string | undefined;
  added: number;
  removed: number;
  lineCount: number;
  lines: PreviewLine[];
}

interface ChangeGroup {
  start: number;
  end: number;
  lines: PreviewLine[];
}

function expandHint(): string {
  try {
    return keyHint("app.tools.expand", "to expand");
  } catch {
    return "ctrl+o to expand";
  }
}

export function formatApplyPatchCollapsedDiff(
  patchText: string,
  cwd = process.cwd(),
  maxPreviewLines = 10,
): string {
  return renderApplyPatch(patchText, cwd, maxPreviewLines);
}

export function renderApplyPatchCall(patchText: string, cwd = process.cwd()): string {
  return renderApplyPatch(patchText, cwd);
}

function renderApplyPatch(patchText: string, cwd: string, maxPreviewLines?: number): string {
  let actions: ParsedPatchAction[];
  try {
    actions = parsePatchActions({ text: patchText });
  } catch {
    return "";
  }

  const files = buildFilePreviews(actions, cwd);
  if (files.length === 0) return "";

  const totalAdded = files.reduce((sum, file) => sum + file.added, 0);
  const totalRemoved = files.reduce((sum, file) => sum + file.removed, 0);
  const lines: string[] = [];
  const lastTruncatedFile = files.reduce(
    (last, file, index) =>
      file.verb !== "Edit" && maxPreviewLines !== undefined && file.lines.length > maxPreviewLines
        ? index
        : last,
    -1,
  );

  const onlyFile = files.length === 1 ? files[0] : undefined;
  if (onlyFile) {
    lines.push(
      `${onlyFile.verb} ${formatPatchTarget(onlyFile.path, onlyFile.movePath, cwd)} ${renderCounts(onlyFile.added, onlyFile.removed)}`,
    );
    if (onlyFile.lines.length > 0) lines.push("");
    lines.push(...renderFilePreview(onlyFile, maxPreviewLines, lastTruncatedFile === 0));
    return lines.join("\n");
  }

  lines.push(`Edit ${files.length} files ${renderCounts(totalAdded, totalRemoved)}`, "");
  for (const [index, file] of files.entries()) {
    if (index > 0) lines.push("");
    lines.push(
      `→ ${formatPatchTarget(file.path, file.movePath, cwd)} ${renderCounts(file.added, file.removed)}`,
    );
    lines.push(...renderFilePreview(file, maxPreviewLines, lastTruncatedFile === index));
  }

  return lines.join("\n");
}

function renderFilePreview(
  file: FilePreview,
  maxPreviewLines: number | undefined,
  showExpandHint: boolean,
): string[] {
  if (file.verb === "Edit") return renderEditedPreviewLines(file.lines, file.lineCount);
  if (maxPreviewLines === undefined || file.lines.length <= maxPreviewLines)
    return renderPreviewLines(file.lines);

  const visible = file.lines.slice(0, Math.max(0, maxPreviewLines));
  const remaining = file.lines.length - visible.length;
  const suffix = showExpandHint ? `, ${expandHint()}` : "";
  return [...renderPreviewLines(visible), `... (${remaining} more lines${suffix})`];
}

function buildFilePreviews(actions: ParsedPatchAction[], cwd: string): FilePreview[] {
  const files: FilePreview[] = [];
  const virtualFiles = new Map<string, string[] | undefined>();
  const readVirtualFile = (path: string) => {
    if (!virtualFiles.has(path)) virtualFiles.set(path, readFileLines(path, cwd));
    return virtualFiles.get(path) ?? [];
  };

  for (const action of actions) {
    const { file, nextLines } = buildFilePreview(action, readVirtualFile(action.path));
    const existing = files.find(
      (candidate) => candidate.path === file.path && candidate.movePath === file.movePath,
    );
    if (existing) {
      existing.added += file.added;
      existing.removed += file.removed;
      existing.lineCount = nextLines.length;
      if (existing.verb === "Add" && file.verb === "Edit") {
        existing.lines = addedPreviewLines(nextLines);
      } else if (file.verb === "Delete") {
        existing.verb = "Delete";
        existing.lines = file.lines;
      } else {
        if (existing.verb !== file.verb) existing.verb = "Edit";
        existing.lines.push(...file.lines);
      }
    } else {
      files.push(file);
    }

    if (action.type === "delete" || action.movePath) virtualFiles.set(action.path, undefined);
    if (action.type !== "delete") virtualFiles.set(action.movePath ?? action.path, nextLines);
  }
  return files;
}

function buildFilePreview(
  action: ParsedPatchAction,
  originalLines: string[],
): { file: FilePreview; nextLines: string[] } {
  if (action.type === "add") {
    const lines = splitFileLines(action.newFile ?? "");
    return {
      file: {
        verb: "Add",
        path: action.path,
        added: lines.length,
        removed: 0,
        lineCount: lines.length,
        lines: addedPreviewLines(lines),
      },
      nextLines: lines,
    };
  }

  if (action.type === "delete") {
    return {
      file: {
        verb: "Delete",
        path: action.path,
        added: 0,
        removed: originalLines.length,
        lineCount: 0,
        lines: originalLines.map((text, index) => ({
          lineNumber: index + 1,
          marker: "-",
          text,
        })),
      },
      nextLines: [],
    };
  }

  const preview = buildUpdatePreview(action, originalLines);
  return {
    file: {
      verb: "Edit",
      path: action.path,
      movePath: action.movePath,
      added: preview.added,
      removed: preview.removed,
      lineCount: preview.nextLines.length,
      lines: preview.lines,
    },
    nextLines: preview.nextLines,
  };
}

function buildUpdatePreview(
  action: ParsedPatchAction,
  originalLines: string[],
): { added: number; removed: number; lines: PreviewLine[]; nextLines: string[] } {
  if (!action.lines) return { added: 0, removed: 0, lines: [], nextLines: originalLines };

  const nextLines = [...originalLines];
  const changeGroups: ChangeGroup[] = [];
  let added = 0;
  let removed = 0;
  let searchStart = 0;
  let delta = 0;
  let index = 0;

  while (index < action.lines.length) {
    const line = action.lines[index];
    if (line === undefined || line === "*** End of File") break;
    if (!line.startsWith("@@")) {
      index += 1;
      continue;
    }

    const changeContext = line.startsWith("@@ ") ? line.slice(3) : undefined;
    index += 1;
    const sectionLines: string[] = [];
    while (index < action.lines.length) {
      const sectionLine = action.lines[index];
      if (
        sectionLine === undefined ||
        sectionLine.startsWith("@@") ||
        sectionLine === "*** End of File"
      )
        break;
      sectionLines.push(sectionLine);
      index += 1;
    }

    if (sectionLines.length === 0) continue;

    const normalizedSection = sectionLines.map(normalizePatchLine);
    const oldSequence = normalizedSection
      .filter((entry) => entry.marker === " " || entry.marker === "-")
      .map((entry) => entry.text);
    const newSequence = normalizedSection
      .filter((entry) => entry.marker === " " || entry.marker === "+")
      .map((entry) => entry.text);
    const contextStart = changeContext
      ? findMatchingSequence(originalLines, [changeContext], searchStart) + 1
      : searchStart;
    const sectionStart =
      oldSequence.length === 0
        ? originalLines.length
        : findMatchingSequence(originalLines, oldSequence, contextStart);
    let oldLineNumber = sectionStart + 1;
    let newLineNumber = sectionStart + 1 + delta;
    let changeGroup: ChangeGroup | undefined;

    for (const rawLine of sectionLines) {
      const entry = normalizePatchLine(rawLine);
      if (entry.marker === "+") {
        added += 1;
        changeGroup ??= { start: newLineNumber - 1, end: newLineNumber - 1, lines: [] };
        changeGroup.lines.push({ lineNumber: newLineNumber, marker: "+", text: entry.text });
        newLineNumber += 1;
        changeGroup.end = newLineNumber - 1;
        continue;
      }

      if (entry.marker === "-") {
        removed += 1;
        changeGroup ??= { start: newLineNumber - 1, end: newLineNumber - 1, lines: [] };
        changeGroup.lines.push({ lineNumber: oldLineNumber, marker: "-", text: entry.text });
        oldLineNumber += 1;
        continue;
      }

      if (changeGroup) {
        changeGroups.push(changeGroup);
        changeGroup = undefined;
      }
      oldLineNumber += 1;
      newLineNumber += 1;
    }
    if (changeGroup) changeGroups.push(changeGroup);

    nextLines.splice(sectionStart + delta, oldSequence.length, ...newSequence);
    searchStart = sectionStart + oldSequence.length;
    delta += newSequence.length - oldSequence.length;
  }

  return { added, removed, lines: buildChangePreview(nextLines, changeGroups), nextLines };
}

function buildChangePreview(
  finalLines: string[],
  groups: ChangeGroup[],
  contextLines = 4,
): PreviewLine[] {
  const lines: PreviewLine[] = [];
  let groupIndex = 0;

  while (groupIndex < groups.length) {
    const first = groups[groupIndex];
    if (!first) break;
    let lastIndex = groupIndex;
    let regionEnd = first.end + contextLines;
    while (lastIndex + 1 < groups.length) {
      const next = groups[lastIndex + 1];
      if (!next || next.start - contextLines > regionEnd) break;
      lastIndex += 1;
      regionEnd = Math.max(regionEnd, next.end + contextLines);
    }

    let cursor = Math.max(0, first.start - contextLines);
    for (let index = groupIndex; index <= lastIndex; index += 1) {
      const group = groups[index];
      if (!group) continue;
      for (; cursor < group.start; cursor += 1) {
        const text = finalLines[cursor];
        if (text !== undefined) lines.push({ lineNumber: cursor + 1, marker: " ", text });
      }
      lines.push(...group.lines);
      cursor = group.end;
    }
    for (const end = Math.min(finalLines.length, regionEnd); cursor < end; cursor += 1) {
      const text = finalLines[cursor];
      if (text !== undefined) lines.push({ lineNumber: cursor + 1, marker: " ", text });
    }
    groupIndex = lastIndex + 1;
  }

  return lines;
}

function formatPreviewLine(line: PreviewLine, lines: PreviewLine[]): string {
  const numberWidth = Math.max(1, ...lines.map((entry) => String(entry.lineNumber).length));
  return `${String(line.lineNumber).padStart(numberWidth, " ")} ${line.marker}${sanitizeText(line.text)}`;
}

function renderPreviewLines(lines: PreviewLine[]): string[] {
  if (lines.length === 0) return [];

  const numberWidth = Math.max(1, ...lines.map((entry) => String(entry.lineNumber).length));
  const diffText = lines
    .map(
      (line) =>
        `${line.marker}${String(line.lineNumber).padStart(numberWidth, " ")} ${sanitizeText(line.text)}`,
    )
    .join("\n");
  try {
    return renderDiff(diffText).split("\n");
  } catch {
    return lines.map((line) => formatPreviewLine(line, lines));
  }
}

function addedPreviewLines(lines: string[]): PreviewLine[] {
  return lines.map((text, index) => ({ lineNumber: index + 1, marker: "+", text }));
}

function renderEditedPreviewLines(
  lines: PreviewLine[],
  lineCount: number,
  contextLines = 4,
): string[] {
  const changedIndexes = lines
    .map((line, index) => (line.marker === " " ? -1 : index))
    .filter((index) => index >= 0);
  if (changedIndexes.length === 0) return [];

  const visible = new Set<number>();
  for (const index of changedIndexes) {
    const start = Math.max(0, index - contextLines);
    const end = Math.min(lines.length - 1, index + contextLines);
    for (let current = start; current <= end; current += 1) visible.add(current);
  }

  const numberWidth = Math.max(1, ...lines.map((entry) => String(entry.lineNumber).length));
  const ranges: Array<{ start: number; end: number }> = [];
  for (const index of [...visible].sort((left, right) => left - right)) {
    const range = ranges.at(-1);
    const previousLine = range ? lines[range.end] : undefined;
    const currentLine = lines[index];
    if (
      range &&
      index === range.end + 1 &&
      previousLine &&
      currentLine &&
      currentLine.lineNumber <= previousLine.lineNumber + 1
    )
      range.end = index;
    else ranges.push({ start: index, end: index });
  }

  const rendered: string[] = [];
  for (const [index, range] of ranges.entries()) {
    const firstLine = lines[range.start];
    if (index > 0 || range.start > 0 || (firstLine?.lineNumber ?? 1) > 1)
      rendered.push(`${"".padStart(numberWidth + 2, " ")}...`);
    rendered.push(...renderPreviewLines(lines.slice(range.start, range.end + 1)));
  }
  const lastRange = ranges.at(-1);
  const lastLine = lastRange ? lines[lastRange.end] : undefined;
  if (
    lastRange &&
    (lastRange.end < lines.length - 1 || (lastLine?.lineNumber ?? lineCount) < lineCount)
  )
    rendered.push(`${"".padStart(numberWidth + 2, " ")}...`);
  return rendered;
}

function normalizePatchLine(rawLine: string): PreviewLine {
  const normalized = rawLine === "" ? " " : rawLine;
  const marker = normalized[0] ?? " ";
  if (marker !== " " && marker !== "+" && marker !== "-") {
    return { lineNumber: 0, marker: " ", text: rawLine };
  }
  return { lineNumber: 0, marker, text: normalized.slice(1) };
}

function findMatchingSequence(lines: string[], context: string[], start: number): number {
  if (context.length === 0) return start;

  const exact = findSequence(lines, context, start, (value) => value);
  if (exact !== -1) return exact;

  const trimEnd = findSequence(lines, context, start, (value) => value.trimEnd());
  if (trimEnd !== -1) return trimEnd;

  const trim = findSequence(lines, context, start, (value) => value.trim());
  if (trim !== -1) return trim;

  return start;
}

function findSequence(
  lines: string[],
  context: string[],
  start: number,
  normalize: (value: string) => string,
): number {
  for (let lineIndex = start; lineIndex <= lines.length - context.length; lineIndex += 1) {
    let matches = true;
    for (let contextIndex = 0; contextIndex < context.length; contextIndex += 1) {
      const line = lines[lineIndex + contextIndex];
      const contextLine = context[contextIndex];
      if (
        line === undefined ||
        contextLine === undefined ||
        normalize(line) !== normalize(contextLine)
      ) {
        matches = false;
        break;
      }
    }
    if (matches) return lineIndex;
  }
  return -1;
}

export function formatPatchTarget(path: string, movePath: string | undefined, cwd: string): string {
  const from = displayPath(path, cwd);
  if (!movePath) return from;
  return `${from} → ${displayPath(movePath, cwd)}`;
}

function displayPath(path: string, cwd: string): string {
  if (!isAbsolute(path)) return sanitizeSingleLine(path);

  const relativePath = relative(cwd, path);
  if (relativePath !== "" && !relativePath.startsWith("..") && !isAbsolute(relativePath)) {
    return sanitizeSingleLine(relativePath);
  }
  return sanitizeSingleLine(path);
}

function readFileLines(path: string, cwd: string): string[] {
  try {
    return splitFileLines(openFileAtPath({ cwd, path }));
  } catch {
    return [];
  }
}

function splitFileLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function renderCounts(added: number, removed: number): string {
  return `(+${added} -${removed})`;
}
