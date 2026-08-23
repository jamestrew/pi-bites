import { isAbsolute, relative } from "node:path";
import { keyHint, renderDiff } from "@earendil-works/pi-coding-agent";

import { openFileAtPath } from "../patch/paths.js";
import { parsePatchActions } from "../patch/parser.js";
import type { ParsedPatchAction } from "../patch/types.js";

interface PreviewLine {
  lineNumber: number;
  marker: " " | "+" | "-";
  text: string;
}

interface FilePreview {
  verb: "Added" | "Deleted" | "Edited";
  path: string;
  movePath?: string | undefined;
  added: number;
  removed: number;
  lines: PreviewLine[];
}

function expandHint(): string {
  try {
    return keyHint("app.tools.expand", "to expand");
  } catch {
    return "ctrl+o to expand";
  }
}

export function formatApplyPatchSummary(patchText: string, cwd = process.cwd()): string {
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

  const onlyFile = files.length === 1 ? files[0] : undefined;
  if (onlyFile) {
    lines.push(
      `${onlyFile.verb} ${formatPatchTarget(onlyFile.path, onlyFile.movePath, cwd)} ${renderCounts(onlyFile.added, onlyFile.removed)}`,
    );
    return lines.join("\n");
  }

  lines.push(`Edited ${files.length} files ${renderCounts(totalAdded, totalRemoved)}`);
  for (const file of files) {
    lines.push(
      `→ ${formatPatchTarget(file.path, file.movePath, cwd)} ${renderCounts(file.added, file.removed)}`,
    );
  }

  return lines.join("\n");
}

export function formatApplyPatchCollapsedDiff(
  patchText: string,
  cwd = process.cwd(),
  maxPreviewLines = 10,
): string {
  const full = renderApplyPatchCall(patchText, cwd);
  if (!full) return formatApplyPatchSummary(patchText, cwd);
  const fullLines = full.split("\n");
  const visibleLines = fullLines.slice(0, maxPreviewLines + 1);
  const remaining = fullLines.length - visibleLines.length;
  const lines = [...visibleLines];
  if (remaining > 0) lines.push(`... (${remaining} more lines, ${expandHint()})`);
  return lines.join("\n");
}

export function renderApplyPatchCall(patchText: string, cwd = process.cwd()): string {
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

  const onlyFile = files.length === 1 ? files[0] : undefined;
  if (onlyFile) {
    lines.push(
      `${onlyFile.verb} ${formatPatchTarget(onlyFile.path, onlyFile.movePath, cwd)} ${renderCounts(onlyFile.added, onlyFile.removed)}`,
    );
    lines.push(...renderPreviewLines(onlyFile.lines));
    return lines.join("\n");
  }

  lines.push(`Edited ${files.length} files ${renderCounts(totalAdded, totalRemoved)}`);
  for (const [index, file] of files.entries()) {
    if (index > 0) lines.push("");
    lines.push(
      `→ ${formatPatchTarget(file.path, file.movePath, cwd)} ${renderCounts(file.added, file.removed)}`,
    );
    lines.push(...renderPreviewLines(file.lines));
  }

  return lines.join("\n");
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
      if (existing.verb !== file.verb) existing.verb = "Edited";
      existing.added += file.added;
      existing.removed += file.removed;
      existing.lines.push(...file.lines);
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
        verb: "Added",
        path: action.path,
        added: lines.length,
        removed: 0,
        lines: lines.map((text, index) => ({ lineNumber: index + 1, marker: "+", text })),
      },
      nextLines: lines,
    };
  }

  if (action.type === "delete") {
    return {
      file: {
        verb: "Deleted",
        path: action.path,
        added: 0,
        removed: originalLines.length,
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
      verb: "Edited",
      path: action.path,
      movePath: action.movePath,
      added: preview.added,
      removed: preview.removed,
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
  const renderedLines: PreviewLine[] = [];
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

    for (const rawLine of sectionLines) {
      const entry = normalizePatchLine(rawLine);
      if (entry.marker === "+") {
        added += 1;
        renderedLines.push({ lineNumber: newLineNumber, marker: "+", text: entry.text });
        newLineNumber += 1;
        continue;
      }

      if (entry.marker === "-") {
        removed += 1;
        renderedLines.push({ lineNumber: oldLineNumber, marker: "-", text: entry.text });
        oldLineNumber += 1;
        continue;
      }

      renderedLines.push({ lineNumber: newLineNumber, marker: " ", text: entry.text });
      oldLineNumber += 1;
      newLineNumber += 1;
    }

    nextLines.splice(sectionStart + delta, oldSequence.length, ...newSequence);
    searchStart = sectionStart + oldSequence.length;
    delta += newSequence.length - oldSequence.length;
  }

  return { added, removed, lines: renderedLines, nextLines };
}

function formatPreviewLine(line: PreviewLine, lines: PreviewLine[]): string {
  const numberWidth = Math.max(1, ...lines.map((entry) => String(entry.lineNumber).length));
  return `${String(line.lineNumber).padStart(numberWidth, " ")} ${line.marker}${line.text}`;
}

function renderPreviewLines(lines: PreviewLine[]): string[] {
  if (lines.length === 0) return [];

  const numberWidth = Math.max(1, ...lines.map((entry) => String(entry.lineNumber).length));
  const diffText = lines
    .map(
      (line) => `${line.marker}${String(line.lineNumber).padStart(numberWidth, " ")} ${line.text}`,
    )
    .join("\n");
  try {
    return renderDiff(diffText).split("\n");
  } catch {
    return lines.map((line) => formatPreviewLine(line, lines));
  }
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
  if (!isAbsolute(path)) return path;

  const relativePath = relative(cwd, path);
  if (relativePath !== "" && !relativePath.startsWith("..") && !isAbsolute(relativePath)) {
    return relativePath;
  }
  return path;
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
