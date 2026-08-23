import { randomBytes } from "node:crypto";

const DEFAULT_MAX_OUTPUT_TOKENS = 10_000;
const TRUNCATION_NOTICE = "[Earlier output truncated]\n";

export interface ExecOutputSessionState {
  buffer: string;
  bufferStartOffset: number;
  emittedOffset: number;
}

function maxCharsForTokens(maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS): number {
  return Math.max(256, maxOutputTokens * 4);
}

function stripTerminalControlSequences(text: string): string {
  const withoutOscAndDcs = text
    // oxlint-disable-next-line no-control-regex -- terminal protocol bytes are intentional
    .replace(/\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g, "")
    // oxlint-disable-next-line no-control-regex -- terminal protocol bytes are intentional
    .replace(/\u001B[P_X^][\s\S]*?\u001B\\/g, "");
  return (
    withoutOscAndDcs
      // oxlint-disable-next-line no-control-regex -- terminal protocol bytes are intentional
      .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
      // oxlint-disable-next-line no-control-regex -- terminal protocol bytes are intentional
      .replace(/\u001B[@-_]/g, "")
      .replaceAll("\u001B", "")
  );
}

export interface PipeOutputNormalizer {
  write(text: string): string;
  end(): string;
}

type TerminalSequence =
  | "normal"
  | "escape"
  | "csi"
  | "osc"
  | "osc-escape"
  | "string"
  | "string-escape";

/** Normalize pipe output without corrupting CRLF or terminal sequences split across bridge chunks. */
export function createPipeOutputNormalizer(): PipeOutputNormalizer {
  let sequence: TerminalSequence = "normal";
  let pendingCarriageReturn = false;

  function write(text: string): string {
    let output = "";
    const emitNormal = (char: string): void => {
      if (pendingCarriageReturn) {
        output += "\n";
        pendingCarriageReturn = false;
        if (char === "\n") return;
      }
      if (char === "\r") {
        pendingCarriageReturn = true;
        return;
      }
      const code = char.codePointAt(0);
      if (code === undefined) return;
      if (code === 0x09 || code === 0x0a) {
        output += char;
        return;
      }
      if (code <= 0x1f || (code >= 0xfff9 && code <= 0xfffb)) return;
      output += char;
    };

    for (const char of text) {
      const code = char.codePointAt(0) ?? 0;
      if (sequence === "normal") {
        if (char === "\u001B") sequence = "escape";
        else emitNormal(char);
      } else if (sequence === "escape") {
        if (char === "[") sequence = "csi";
        else if (char === "]") sequence = "osc";
        else if (char === "P" || char === "_" || char === "X" || char === "^") sequence = "string";
        else {
          sequence = "normal";
          if (code < 0x40 || code > 0x5f) emitNormal(char);
        }
      } else if (sequence === "csi") {
        if (code >= 0x40 && code <= 0x7e) sequence = "normal";
      } else if (sequence === "osc") {
        if (char === "\u0007") sequence = "normal";
        else if (char === "\u001B") sequence = "osc-escape";
      } else if (sequence === "osc-escape") {
        sequence = char === "\\" ? "normal" : char === "\u001B" ? "osc-escape" : "osc";
      } else if (sequence === "string") {
        if (char === "\u001B") sequence = "string-escape";
      } else {
        sequence = char === "\\" ? "normal" : char === "\u001B" ? "string-escape" : "string";
      }
    }
    return output;
  }

  return {
    write,
    end() {
      const output = pendingCarriageReturn ? "\n" : "";
      pendingCarriageReturn = false;
      sequence = "normal";
      return output;
    },
  };
}

export function normalizePipeOutput(text: string): string {
  const normalizer = createPipeOutputNormalizer();
  return normalizer.write(text) + normalizer.end();
}

export function renderTerminalOutput(text: string): string {
  let committed = "";
  let line: string[] = [];
  let cursor = 0;

  for (const char of stripTerminalControlSequences(text)) {
    const code = char.codePointAt(0);
    if (
      code === undefined ||
      (code < 0x20 && char !== "\t" && char !== "\n" && char !== "\r" && char !== "\b") ||
      (code >= 0x7f && code <= 0x9f)
    )
      continue;
    if (char === "\r") {
      cursor = 0;
      continue;
    }
    if (char === "\n") {
      committed += `${line.join("")}\n`;
      line = [];
      cursor = 0;
      continue;
    }
    if (char === "\b") {
      cursor = Math.max(0, cursor - 1);
      continue;
    }
    if (cursor > line.length) line.push(...Array.from({ length: cursor - line.length }, () => " "));
    line[cursor] = char;
    cursor += 1;
  }

  return committed + line.join("");
}

export function truncateToTail(
  text: string,
  maxChars: number,
): { output: string; removed: number } {
  let start = Math.max(0, text.length - maxChars);
  if (start > 0 && start < text.length && /[\uDC00-\uDFFF]/.test(text.charAt(start))) start += 1;
  return { output: text.slice(start), removed: start };
}

export function generateChunkId(): string {
  return randomBytes(3).toString("hex");
}

export function truncateOutput(
  text: string,
  maxOutputTokens?: number,
  originalCharCount = text.length,
): { output: string; original_token_count?: number | undefined } {
  if (text.length === 0 && originalCharCount === 0) return { output: "" };
  const maxChars = maxCharsForTokens(maxOutputTokens);
  const originalTokenCount = Math.ceil(Math.max(text.length, originalCharCount) / 4);
  if (text.length <= maxChars && originalCharCount <= maxChars)
    return { output: text, original_token_count: originalTokenCount };
  const tailChars = Math.max(0, maxChars - TRUNCATION_NOTICE.length);
  return {
    output: TRUNCATION_NOTICE + truncateToTail(text, tailChars).output,
    original_token_count: originalTokenCount,
  };
}

function outputSince(
  session: ExecOutputSessionState,
  offset: number,
): { text: string; originalCharCount: number; endOffset: number } {
  const endOffset = session.bufferStartOffset + session.buffer.length;
  const startOffset = Math.max(offset, session.bufferStartOffset);
  return {
    text: session.buffer.slice(startOffset - session.bufferStartOffset),
    originalCharCount: Math.max(0, endOffset - offset),
    endOffset,
  };
}

export function consumeOutput(
  session: ExecOutputSessionState,
  maxOutputTokens?: number,
): { output: string; original_token_count?: number | undefined } {
  const output = outputSince(session, session.emittedOffset);
  session.emittedOffset = output.endOffset;
  return truncateOutput(output.text, maxOutputTokens, output.originalCharCount);
}

export function peekUnconsumedOutput(
  session: ExecOutputSessionState,
  maxOutputTokens?: number,
): { output: string; original_token_count?: number | undefined } {
  const output = outputSince(session, session.emittedOffset);
  return truncateOutput(output.text, maxOutputTokens, output.originalCharCount);
}

export function peekOutputSince(
  session: ExecOutputSessionState,
  baselineOffset: number,
  maxOutputTokens?: number,
): { output: string; original_token_count?: number | undefined } {
  const output = outputSince(session, baselineOffset);
  return truncateOutput(output.text, maxOutputTokens, output.originalCharCount);
}
