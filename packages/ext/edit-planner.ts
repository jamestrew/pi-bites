export type EditMatchTier = "exact" | "whitespace-unicode" | "indentation";

export interface EditPlan {
  content: string;
  nextContent: string;
  matchTier: EditMatchTier;
  replacementCount: number;
}

type Match = { start: number; end: number };

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

function normalizeUnicode(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

function findAll(text: string, target: string): Match[] {
  if (!target) return [];
  const matches: Match[] = [];
  for (
    let start = text.indexOf(target);
    start !== -1;
    start = text.indexOf(target, start + target.length)
  ) {
    matches.push({ start, end: start + target.length });
  }
  return matches;
}

function normalizedWhitespaceView(text: string) {
  let normalized = "";
  const starts: number[] = [];
  const ends: number[] = [];
  let offset = 0;

  for (const segment of text.match(/[^\n]*(?:\n|$)/g) ?? []) {
    if (!segment) continue;
    const hasNewline = segment.endsWith("\n");
    const line = hasNewline ? segment.slice(0, -1) : segment;
    const kept = line.trimEnd();
    for (const { segment: grapheme, index: segmentOffset } of graphemes.segment(kept)) {
      const transformed = normalizeUnicode(grapheme);
      normalized += transformed;
      for (let index = 0; index < transformed.length; index++) {
        starts.push(offset + segmentOffset);
        ends.push(offset + segmentOffset + grapheme.length);
      }
    }

    if (hasNewline) {
      normalized += "\n";
      starts.push(offset + line.length);
      ends.push(offset + line.length + 1);
    }
    offset += segment.length;
  }

  return { normalized, starts, ends };
}

function whitespaceUnicodeMatches(content: string, oldString: string): Match[] {
  const contentView = normalizedWhitespaceView(content);
  const target = normalizedWhitespaceView(oldString).normalized;
  if (!target) return [];

  return findAll(contentView.normalized, target).flatMap(({ start, end }) => {
    const originalStart = contentView.starts[start];
    const originalEnd = contentView.ends[end - 1];
    return originalStart === undefined || originalEnd === undefined
      ? []
      : [{ start: originalStart, end: originalEnd }];
  });
}

function linesWithSpans(content: string) {
  const lines: Array<{ text: string; start: number; end: number; hasNewline: boolean }> = [];
  let start = 0;
  for (const segment of content.match(/[^\n]*(?:\n|$)/g) ?? []) {
    if (!segment) continue;
    const hasNewline = segment.endsWith("\n");
    const text = hasNewline ? segment.slice(0, -1) : segment;
    lines.push({ text, start, end: start + segment.length, hasNewline });
    start += segment.length;
  }
  return lines;
}

function indentationMatches(content: string, oldString: string): Match[] {
  const contentLines = linesWithSpans(content);
  const oldLines = linesWithSpans(oldString);
  if (oldLines.every((line) => !normalizeUnicode(line.text.trim()))) {
    return [];
  }

  const matches: Match[] = [];
  for (let index = 0; index <= contentLines.length - oldLines.length; index++) {
    const matchesWindow = oldLines.every((oldLine, lineIndex) => {
      const contentLine = contentLines[index + lineIndex];
      if (!contentLine || (oldLine.hasNewline && !contentLine.hasNewline)) return false;
      return normalizeUnicode(oldLine.text.trim()) === normalizeUnicode(contentLine.text.trim());
    });
    if (!matchesWindow) continue;

    const first = contentLines[index];
    const last = contentLines[index + oldLines.length - 1];
    if (!first || !last) continue;
    matches.push({
      start: first.start,
      end: oldLines.at(-1)?.hasNewline ? last.end : last.end - (last.hasNewline ? 1 : 0),
    });
    index += oldLines.length - 1;
  }
  return matches;
}

function findMatches(content: string, oldString: string) {
  const tiers: Array<[EditMatchTier, () => Match[]]> = [
    ["exact", () => findAll(content, oldString)],
    ["whitespace-unicode", () => whitespaceUnicodeMatches(content, oldString)],
    ["indentation", () => indentationMatches(content, oldString)],
  ];
  for (const [matchTier, find] of tiers) {
    const matches = find();
    if (matches.length > 0) return { matchTier, matches };
  }
}

function applyMatches(content: string, matches: Match[], replacement: string): string {
  let result = content;
  for (const match of [...matches].reverse()) {
    result = result.slice(0, match.start) + replacement + result.slice(match.end);
  }
  return result;
}

export function planEdit(
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
  filePath: string,
): EditPlan {
  if (!oldString) throw new Error("old_string must not be empty.");

  const found = findMatches(content, oldString);
  if (!found) {
    throw new Error(`Could not find old_string in ${filePath}. Reread the file and try again.`);
  }
  if (!replaceAll && found.matches.length !== 1) {
    throw new Error(
      `Found ${found.matches.length} matches for old_string in ${filePath}. Add context to make it unique or set replace_all to true.`,
    );
  }

  const matches = replaceAll ? found.matches : found.matches.slice(0, 1);
  const nextContent = applyMatches(content, matches, newString);
  if (nextContent === content) {
    throw new Error(`No changes made to ${filePath}; the replacement produced identical content.`);
  }

  return {
    content,
    nextContent,
    matchTier: found.matchTier,
    replacementCount: matches.length,
  };
}
