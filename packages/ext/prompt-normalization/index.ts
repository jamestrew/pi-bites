import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function stripTrailingHorizontalWhitespace(text: string): string {
  return text.replace(/[\t ]+$/gm, "");
}

export default function registerPromptNormalization(pi: ExtensionAPI) {
  pi.on("input", async (event) => {
    if (event.source === "extension") return { action: "continue" };

    const text = stripTrailingHorizontalWhitespace(event.text);
    if (text === event.text) return { action: "continue" };

    return { action: "transform", text };
  });
}
