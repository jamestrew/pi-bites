import type { AgentEndEvent } from "@earendil-works/pi-coding-agent";

export function extractLastAssistantText(messages: AgentEndEvent["messages"]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    const text = message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("")
      .trim();
    if (text) return text;
  }
}
