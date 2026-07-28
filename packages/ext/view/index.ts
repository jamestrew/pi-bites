import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";

function dedent(lines: string[]): string[] {
  while (lines[0]?.trim() === "") lines.shift();
  while (lines.at(-1)?.trim() === "") lines.pop();

  const indentation = lines
    .filter((line) => line.trim())
    .reduce((minimum, line) => Math.min(minimum, line.match(/^[\t ]*/)?.[0].length ?? 0), Infinity);

  return indentation === Infinity ? lines : lines.map((line) => line.slice(indentation));
}

export function formatMarkdown(markdown: string): string {
  const output: string[] = [];
  let fence: { character: string; length: number } | undefined;
  let code: string[] = [];

  for (const line of dedent(markdown.split(/\r?\n/))) {
    if (!fence) {
      const opening = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
      if (!opening?.[1]) {
        output.push(line);
        continue;
      }

      fence = { character: opening[1].charAt(0), length: opening[1].length };
      output.push(`${opening[1]}${opening[2] ?? ""}`.trimEnd());
      continue;
    }

    const closing = line.match(/^\s*(`+|~+)\s*$/)?.[1];
    if (closing?.[0] === fence.character && closing.length >= fence.length) {
      output.push(...dedent(code), closing);
      fence = undefined;
      code = [];
    } else {
      code.push(line);
    }
  }

  if (fence) output.push(...dedent(code));
  return `${output.join("\n").trim()}\n`;
}

function lastAssistantText(entries: readonly SessionEntry[]): string | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry?.type !== "message" || entry.message.role !== "assistant") continue;
    const text = entry.message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
    if (text.trim()) return text;
  }
}

export default function registerView(pi: ExtensionAPI): void {
  pi.registerCommand("view", {
    description: "Export the last agent message as unpadded Markdown",
    handler: async (_args, ctx) => {
      const text = lastAssistantText(ctx.sessionManager.getBranch());
      if (!text) {
        ctx.ui.notify("No agent message to export", "warning");
        return;
      }

      try {
        const directory = join(tmpdir(), `pi-view-${process.pid}`);
        const path = join(directory, "last-message.md");
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await writeFile(path, formatMarkdown(text), { encoding: "utf8", mode: 0o600 });
        ctx.ui.notify(path, "info");
      } catch (error) {
        ctx.ui.notify(`Could not export message: ${String(error)}`, "error");
      }
    },
  });
}
