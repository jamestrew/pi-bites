type TextContent = { type: "text"; text?: unknown };

export function extractText(content: unknown[]): string {
  return content
    .filter(
      (item): item is TextContent =>
        typeof item === "object" && item !== null && "type" in item && item.type === "text",
    )
    .map((item) => (typeof item.text === "string" ? item.text : ""))
    .join("\n");
}
