import { stripVTControlCharacters } from "node:util";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

/** Remove terminal controls before rendering model-controlled text. */
export function sanitizeText(text: string): string {
  return (
    stripVTControlCharacters(text)
      .replaceAll("\t", "  ")
      // eslint-disable-next-line no-control-regex -- control characters are what this removes.
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "")
  );
}

/** Sanitize metadata that must occupy one physical line. */
export function sanitizeSingleLine(text: string): string {
  return sanitizeText(text).replaceAll("\n", " ");
}

/** Fit a complete rendered line, including its prefix, to the TUI width. */
export function fitLine(text: string, width: number): string {
  return width > 0 ? truncateToWidth(text, width, "…") : "";
}

/** Sanitize and wrap source text while preserving blank lines. */
export function wrapDisplayLines(text: string, width: number): string[] {
  return sanitizeText(text)
    .split("\n")
    .flatMap((line) => {
      const wrapped = wrapTextWithAnsi(line, Math.max(1, width));
      return wrapped.length > 0 ? wrapped : [""];
    });
}
