import type { RuntimeContentItem } from "./types.js";

// Port of the pinned utils/{string,output-truncation}: UTF-8 byte estimates and
// middle truncation. Image items don't spend the text token budget.
function truncate(text: string, tokens: number): string {
  const bytes = Buffer.from(text);
  const budget = tokens * 4;
  if (bytes.length <= budget) return text;
  let left = Math.floor(budget / 2);
  let right = bytes.length - (budget - left);
  while (left > 0 && ((bytes[left] ?? 0) & 0xc0) === 0x80) left--;
  while (right < bytes.length && ((bytes[right] ?? 0) & 0xc0) === 0x80) right++;
  return `${bytes.subarray(0, left).toString()}…${Math.ceil((bytes.length - budget) / 4)} tokens truncated…${bytes.subarray(right).toString()}`;
}

export function truncateCodeModeOutput(
  items: RuntimeContentItem[],
  tokens: number,
): RuntimeContentItem[] {
  if (items.every((item) => item.type === "input_text")) {
    const text = items
      .map((item) => item.text)
      .reduce((combined, part) => (combined ? `${combined}\n${part}` : part), "");
    if (Buffer.byteLength(text) <= tokens * 4) return items;
    const lines = text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length;
    return [
      {
        type: "input_text",
        text: `Warning: truncated output (original token count: ${Math.ceil(Buffer.byteLength(text) / 4)})\nTotal output lines: ${lines}\n\n${truncate(text, tokens)}`,
      },
    ];
  }
  let remaining = tokens;
  let omitted = 0;
  const result: RuntimeContentItem[] = [];
  for (const item of items) {
    if (item.type === "input_image") result.push(item);
    else if (remaining === 0) omitted++;
    else {
      result.push({ type: "input_text", text: truncate(item.text, remaining) });
      remaining = Math.max(0, remaining - Math.ceil(Buffer.byteLength(item.text) / 4));
    }
  }
  if (omitted) result.push({ type: "input_text", text: `[omitted ${omitted} text items ...]` });
  return result;
}
