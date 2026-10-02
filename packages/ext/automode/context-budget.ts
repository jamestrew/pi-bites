// Codex's provider-neutral estimate: four UTF-8 bytes per token.
export function approximateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 4);
}

export function evidenceJson(value: unknown): string {
  return JSON.stringify(value).replace(
    /[<>&]/g,
    (char) => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0"),
  );
}

/** Preserve both ends without splitting UTF-8 characters; omissions remain explicit. */
export function truncateTokens(text: string, tokens: number): string {
  const bytes = Buffer.from(text);
  const budget = tokens * 4;
  if (bytes.length <= budget) return text;
  const marker = '\n<truncated omitted_approx_tokens="' + Math.ceil(bytes.length / 4) + '"/>\n';
  const available = Math.max(0, budget - Buffer.byteLength(marker));
  let end = Math.floor(available / 2);
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
  let start = bytes.length - (available - Math.floor(available / 2));
  while (start < bytes.length && ((bytes[start] ?? 0) & 0xc0) === 0x80) start++;
  const omitted = Math.ceil((start - end) / 4);
  return (
    bytes.subarray(0, end).toString() +
    '\n<truncated omitted_approx_tokens="' +
    omitted +
    '"/>\n' +
    bytes.subarray(start).toString()
  );
}
