import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { createLsTool, createReadTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MAX_MENTIONS = 8;

type LineRange = {
  start: number;
  end?: number;
};

type Mention = {
  raw: string;
  path: string;
  lineRange?: LineRange;
};

type Expansion = {
  mention: Mention;
  absolutePath: string;
  text: string;
};

type ParsedLineSuffix = { path: string; lineRange?: LineRange };

function isMentionBoundary(char: string | undefined): boolean {
  return char === undefined || /\s/.test(char);
}

export function parseAtMentions(text: string): Mention[] {
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
    while (end < text.length) {
      const char = text[end];
      if (char === undefined || /\s/.test(char)) break;
      end++;
    }

    const raw = text.slice(i, end);
    const path = raw.slice(1).replace(/[),.;:!?]+$/, "");
    if (path.length === 0) continue;

    mentions.push({ raw: raw.slice(0, path.length + 1), path });
    i = end - 1;
  }

  const seen = new Set<string>();
  return mentions.filter((mention) => {
    const key = `${mention.path}:${mention.lineRange?.start ?? ""}-${mention.lineRange?.end ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parseLineSuffix(path: string): ParsedLineSuffix | null {
  const suffixMatch = path.match(/^(.*):(-?\d+)(?:-(-?\d+))?$/);
  if (!suffixMatch) return null;

  const [, suffixPath, startText, endText] = suffixMatch;
  if (suffixPath === undefined || startText === undefined) return null;
  const start = Number(startText);
  const end = endText ? Number(endText) : undefined;

  if (start < 1 || (end !== undefined && end < start)) return { path: suffixPath };

  return { path: suffixPath, lineRange: { start, end } };
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

export async function expandMention(
  cwd: string,
  mention: Mention,
  signal?: AbortSignal,
): Promise<Expansion | null> {
  let effectiveMention = mention;
  let absolutePath = resolve(cwd, mention.path);

  let stats: Awaited<ReturnType<typeof stat>>;
  try {
    stats = await stat(absolutePath);
  } catch {
    const suffix = parseLineSuffix(mention.path);
    if (suffix === null) return null;

    effectiveMention = { ...mention, path: suffix.path, lineRange: suffix.lineRange };
    absolutePath = resolve(cwd, effectiveMention.path);
    try {
      stats = await stat(absolutePath);
    } catch {
      return null;
    }
  }

  try {
    if (stats.isDirectory()) {
      const lsTool = createLsTool(cwd);
      const result = await lsTool.execute(
        `at-mention-ls:${effectiveMention.path}`,
        { path: effectiveMention.path },
        signal,
      );
      return { mention: effectiveMention, absolutePath, text: textContentOnly(result.content) };
    }

    if (stats.isFile()) {
      const readTool = createReadTool(cwd);
      const result = await readTool.execute(
        `at-mention-read:${effectiveMention.path}`,
        {
          path: effectiveMention.path,
          offset: effectiveMention.lineRange?.start,
          limit:
            effectiveMention.lineRange?.end === undefined
              ? undefined
              : effectiveMention.lineRange.end - effectiveMention.lineRange.start + 1,
        },
        signal,
      );
      return { mention: effectiveMention, absolutePath, text: textContentOnly(result.content) };
    }
  } catch {
    return null;
  }

  return null;
}

function formatExpansion(expansion: Expansion): string {
  return `<file name="${expansion.absolutePath}" mention="${expansion.mention.raw}">\n${expansion.text}\n</file>`;
}

export default function registerAtMentionContext(pi: ExtensionAPI) {
  const lastInjected = new Map<string, string>();
  const clearLastInjected = () => lastInjected.clear();

  pi.on("session_compact", clearLastInjected);
  pi.on("session_tree", clearLastInjected);

  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") return { action: "continue" };

    const mentions = parseAtMentions(event.text).slice(0, MAX_MENTIONS);
    if (mentions.length === 0) return { action: "continue" };

    const cwd = ctx.cwd;
    const signal = ctx.signal;
    const ui = ctx.ui;
    const notify = ui.notify.bind(ui);
    const expansions = (
      await Promise.all(mentions.map((mention) => expandMention(cwd, mention, signal)))
    ).filter((expansion): expansion is Expansion => expansion !== null);
    const changed = expansions
      .map((expansion) => {
        const key = JSON.stringify([
          expansion.absolutePath,
          expansion.mention.lineRange?.start,
          expansion.mention.lineRange?.end,
        ]);
        return { expansion, key, content: formatExpansion(expansion) };
      })
      .filter(({ key, content }) => lastInjected.get(key) !== content);

    if (changed.length === 0) return { action: "continue" };

    const content = [
      "The following files or directories were mentioned by @path in the user's prompt and have been pre-read as context.",
      ...changed.map((item) => item.content),
    ].join("\n\n");

    pi.sendMessage(
      {
        customType: "at-mention-context",
        content,
        display: false,
        details: changed.map(({ expansion }) => expansion.mention.path).join(", "),
      },
      { triggerTurn: false },
    );
    for (const { key, content } of changed) lastInjected.set(key, content);
    notify(
      `Injected at-mention context: ${changed.map(({ expansion }) => expansion.mention.raw).join(", ")}`,
      "info",
    );

    return { action: "continue" };
  });
}
