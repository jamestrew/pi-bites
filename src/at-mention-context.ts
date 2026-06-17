import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { createLsTool, createReadTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MAX_MENTIONS = 8;

type Mention = {
  raw: string;
  path: string;
};

type Expansion = {
  mention: Mention;
  absolutePath: string;
  text: string;
};

function isMentionBoundary(char: string | undefined): boolean {
  return char === undefined || /\s/.test(char);
}

function parseAtMentions(text: string): Mention[] {
  const mentions: Mention[] = [];

  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "@" || !isMentionBoundary(text[i - 1])) continue;

    if (text[i + 1] === '"') {
      let end = i + 2;
      let value = "";
      while (end < text.length) {
        const char = text[end];
        if (char === '"') break;
        value += char;
        end++;
      }
      if (text[end] !== '"' || value.length === 0) continue;
      mentions.push({ raw: text.slice(i, end + 1), path: value });
      i = end;
      continue;
    }

    let end = i + 1;
    while (end < text.length && !/\s/.test(text[end]!)) end++;

    const raw = text.slice(i, end);
    const path = raw.slice(1).replace(/[),.;:!?]+$/, "");
    if (path.length === 0) continue;

    mentions.push({ raw: raw.slice(0, path.length + 1), path });
    i = end - 1;
  }

  const seen = new Set<string>();
  return mentions.filter((mention) => {
    if (seen.has(mention.path)) return false;
    seen.add(mention.path);
    return true;
  });
}

function textContentOnly(
  content: Awaited<ReturnType<ReturnType<typeof createReadTool>["execute"]>>["content"],
): string {
  return content
    .map((part) =>
      part.type === "text" ? part.text : "[Non-text content omitted from @ mention expansion.]",
    )
    .join("\n");
}

async function expandMention(
  cwd: string,
  mention: Mention,
  signal?: AbortSignal,
): Promise<Expansion | null> {
  const absolutePath = resolve(cwd, mention.path);

  let stats: Awaited<ReturnType<typeof stat>>;
  try {
    stats = await stat(absolutePath);
  } catch {
    return null;
  }

  try {
    if (stats.isDirectory()) {
      const lsTool = createLsTool(cwd);
      const result = await lsTool.execute(
        `at-mention-ls:${mention.path}`,
        { path: mention.path },
        signal,
      );
      return { mention, absolutePath, text: textContentOnly(result.content) };
    }

    if (stats.isFile()) {
      const readTool = createReadTool(cwd);
      const result = await readTool.execute(
        `at-mention-read:${mention.path}`,
        { path: mention.path },
        signal,
      );
      return { mention, absolutePath, text: textContentOnly(result.content) };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { mention, absolutePath, text: `[Could not expand @ mention: ${message}]` };
  }

  return null;
}

function formatExpansion(expansion: Expansion): string {
  return `<file name="${expansion.absolutePath}" mention="${expansion.mention.raw}">\n${expansion.text}\n</file>`;
}

export default function registerAtMentionContext(pi: ExtensionAPI) {
  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") return { action: "continue" };

    const mentions = parseAtMentions(event.text).slice(0, MAX_MENTIONS);
    if (mentions.length === 0) return { action: "continue" };

    const expansions = (
      await Promise.all(mentions.map((mention) => expandMention(ctx.cwd, mention, ctx.signal)))
    ).filter((expansion): expansion is Expansion => expansion !== null);

    if (expansions.length === 0) return { action: "continue" };

    const content = [
      "The following files or directories were mentioned by @path in the user's prompt and have been pre-read as context.",
      ...expansions.map(formatExpansion),
    ].join("\n\n");

    pi.sendMessage(
      {
        customType: "at-mention-context",
        content,
        display: false,
        details: expansions.map((expansion) => expansion.mention.path).join(", "),
      },
      { triggerTurn: false },
    );

    return { action: "continue" };
  });
}
