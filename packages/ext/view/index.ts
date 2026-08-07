import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getMarkdownTheme,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { createViewerKeys } from "../subagents/ui/viewer-keys.js";

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

function requestedMessages(
  args: string,
  ctx: ExtensionCommandContext,
  command: "view" | "eview",
): string[] | undefined {
  const count = parseCount(args);
  if (!count) {
    ctx.ui.notify(`Usage: /${command} [positive integer]`, "warning");
    return;
  }

  const messages = assistantTexts(ctx.sessionManager.getBranch(), count).map((message) =>
    formatMarkdown(message).trimEnd(),
  );
  if (messages.length === 0) {
    ctx.ui.notify(`No agent message to ${command === "view" ? "view" : "export"}`, "warning");
    return;
  }
  return messages;
}

export default function registerView(pi: ExtensionAPI): void {
  pi.registerCommand("view", {
    description: "Show recent agent messages as Markdown",
    handler: async (args, ctx) => {
      const messages = requestedMessages(args, ctx, "view");
      if (!messages || ctx.mode !== "tui") return;

      await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
        const keys = createViewerKeys(keybindings);
        const content = new Container();
        for (const [index, message] of messages.entries()) {
          if (index > 0) content.addChild(new Markdown("---", 0, 0, getMarkdownTheme()));
          content.addChild(new Markdown(message, 0, 0, getMarkdownTheme()));
        }
        let offset = 0;
        let width = 0;
        const viewportHeight = () => Math.max(1, tui.terminal.rows - 1);
        const maxOffset = () => Math.max(0, content.render(width).length - viewportHeight());
        const scroll = (next: number) => {
          offset = Math.max(0, Math.min(next, maxOffset()));
          tui.requestRender();
        };

        return {
          render: (availableWidth: number) => {
            width = availableWidth;
            offset = Math.min(offset, maxOffset());
            return [
              ...content.render(width).slice(offset, offset + viewportHeight()),
              truncateToWidth(
                theme.fg("dim", "↑↓ scroll · PgUp/PgDn · Home/End · q/esc/enter close"),
                width,
              ),
            ];
          },
          invalidate: () => content.invalidate(),
          handleInput: (data: string) => {
            if (matchesKey(data, "q") || matchesKey(data, "escape") || matchesKey(data, "enter")) {
              done();
            } else if (keys.scrollUp(data)) {
              scroll(offset - 1);
            } else if (keys.scrollDown(data)) {
              scroll(offset + 1);
            } else if (keys.pageUp(data)) {
              scroll(offset - viewportHeight());
            } else if (keys.pageDown(data)) {
              scroll(offset + viewportHeight());
            } else if (matchesKey(data, "home")) {
              scroll(0);
            } else if (matchesKey(data, "end")) {
              scroll(maxOffset());
            }
          },
        };
      });
    },
  });

  pi.registerCommand("eview", {
    description: "Export recent agent messages as unpadded Markdown",
    handler: async (args, ctx) => {
      const messages = requestedMessages(args, ctx, "eview");
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
