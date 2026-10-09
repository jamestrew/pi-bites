import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";

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

function parseCount(args: string): number | undefined {
  const count = Number(args.trim() || 1);
  return Number.isSafeInteger(count) && count > 0 ? count : undefined;
}

function assistantTexts(entries: readonly SessionEntry[], count: number): string[] {
  const texts: string[] = [];
  for (let index = entries.length - 1; index >= 0 && texts.length < count; index--) {
    const entry = entries[index];
    if (entry?.type !== "message" || entry.message.role !== "assistant") continue;
    const text = entry.message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
    if (text.trim()) texts.unshift(text);
  }
  return texts;
}

function requestedMessages(args: string, ctx: ExtensionCommandContext): string[] | undefined {
  const count = parseCount(args);
  if (!count) {
    ctx.ui.notify("Usage: /eview [positive integer]", "warning");
    return;
  }

  const messages = assistantTexts(ctx.sessionManager.getBranch(), count).map((message) =>
    formatMarkdown(message).trimEnd(),
  );
  if (messages.length === 0) {
    ctx.ui.notify("No agent message to export", "warning");
    return;
  }
  return messages;
}

export default function registerView(pi: ExtensionAPI): void {
  pi.registerCommand("eview", {
    description: "Export recent agent messages as unpadded Markdown",
    handler: async (args, ctx) => {
      const messages = requestedMessages(args, ctx);
      if (!messages) return;
      const text = messages.join("\n\n---\n\n");

      try {
        const directory = join(tmpdir(), `pi-view-${process.pid}`);
        const path = join(directory, "last-message.md");
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await writeFile(path, `${text}\n`, { encoding: "utf8", mode: 0o600 });
        ctx.ui.notify(path, "info");
      } catch (error) {
        ctx.ui.notify(`Could not export message: ${String(error)}`, "error");
      }
    },
  });
}
