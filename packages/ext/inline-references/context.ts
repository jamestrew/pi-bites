import { randomUUID } from "node:crypto";

const CONTEXT_START = '\n\n<pi-bites-inline-context id="';
const CONTEXT_END = "\n</pi-bites-inline-context>";
const CONTEXT_PATTERN =
  /(?:^|\n\n)<pi-bites-inline-context id="([0-9a-f-]{36})">\n[\s\S]*?\n<\/pi-bites-inline-context>\n<!-- pi-bites-inline-context:\1 -->/g;

export function stripInlineContext(text: string): string {
  return text.replace(CONTEXT_PATTERN, "");
}

export function appendInlineContext(text: string, content: string): string {
  // Match owned context even when the user's text or referenced files quote our tags.
  const id = randomUUID();
  return `${text}${CONTEXT_START}${id}">\n${content}${CONTEXT_END}\n<!-- pi-bites-inline-context:${id} -->`;
}
