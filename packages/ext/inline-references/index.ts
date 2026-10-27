import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { stripFrontmatter, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerDollarAutocomplete } from "./autocomplete.js";
import { appendInlineContext, stripInlineContext } from "./context.js";
import { expandMention, formatExpansion, parseAtMentions } from "./files.js";

type InlineReferenceKind = "skill" | "prompt";

type InlineReference = {
  kind: InlineReferenceKind;
  name: string;
  raw: string;
};

function isReferenceBoundary(char: string | undefined): boolean {
  return char === undefined || /\s/.test(char);
}

export function parseInlineReferences(text: string): InlineReference[] {
  const refs: InlineReference[] = [];

  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "$" || !isReferenceBoundary(text[i - 1])) continue;

    const match = text.slice(i).match(/^\$(skill|prompt):([^\s]+)/);
    if (!match) continue;

    const kind: InlineReferenceKind = match[1] === "skill" ? "skill" : "prompt";
    const matchedName = match[2];
    if (matchedName === undefined) continue;
    const name = matchedName.replace(/[),.;!?]+$/, "");
    if (name.length === 0) continue;

    const raw = `$${kind}:${name}`;
    refs.push({ kind, name, raw });
    i += raw.length - 1;
  }

  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = `${ref.kind}:${ref.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export default function registerInlineReferences(
  pi: ExtensionAPI,
  options: { files?: boolean; skillsAndPrompts?: boolean } = {},
) {
  if (options.skillsAndPrompts !== false) registerDollarAutocomplete(pi);
  pi.registerMarkdownTransformer((markdown, context) =>
    context.messageType === "user" ? stripInlineContext(markdown) : markdown,
  );
  const lastInjected = new Map<string, string>();
  const clear = () => lastInjected.clear();
  pi.on("session_start", clear);
  pi.on("session_compact", clear);
  pi.on("session_tree", clear);

  // Remove replayed attachments before native template argument parsing can corrupt them.
  pi.on("input", (event) => {
    const text = stripInlineContext(event.text);
    return text === event.text ? { action: "continue" } : { action: "transform", text };
  });

  // Finalized user messages have already expanded native templates and left the queue.
  pi.on("message_end", async ({ message }, ctx) => {
    if (message.role !== "user") return;
    const text =
      typeof message.content === "string"
        ? message.content
        : message.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n");
    const mentions = options.files === false ? [] : parseAtMentions(text).slice(0, 8);
    const refs = options.skillsAndPrompts === false ? [] : parseInlineReferences(text);
    if (!mentions.length && !refs.length) return;

    const cwd = ctx.cwd;
    const signal = ctx.signal;
    const ui = ctx.ui;
    const notify = ui.notify.bind(ui);
    const commands = refs.length ? pi.getCommands() : [];
    const blocks: string[] = [];
    for (const ref of refs) {
      const command = commands.find(
        (command) =>
          command.source === ref.kind &&
          command.name === (ref.kind === "skill" ? `skill:${ref.name}` : ref.name),
      );
      if (!command) continue;
      try {
        const path = command.sourceInfo.path;
        const body = stripFrontmatter(readFileSync(path, "utf-8")).trim();
        blocks.push(
          ref.kind === "skill"
            ? `<skill name="${ref.name}" location="${path}">\nReferences are relative to ${dirname(path)}.\n\n${body}\n</skill>`
            : `<prompt name="${ref.name}" location="${path}">\n${body}\n</prompt>`,
        );
      } catch {
        // Missing or unreadable references must not prevent submitting the user's message.
      }
    }
    const expansions = await Promise.all(
      mentions.map((mention) => expandMention(cwd, mention, signal)),
    );
    const changed = expansions.flatMap((expansion) => {
      if (!expansion) return [];
      const key = JSON.stringify([
        expansion.absolutePath,
        expansion.mention.lineRange?.start,
        expansion.mention.lineRange?.end,
      ]);
      const content = formatExpansion(expansion);
      return lastInjected.get(key) === content
        ? []
        : [{ key, content, raw: expansion.mention.raw }];
    });
    if (!blocks.length && !changed.length) return;
    const content = [
      "The following referenced content is already loaded; do not read its source files again unless you need to inspect referenced files.",
      ...changed.map(({ content }) => content),
      ...blocks,
    ].join("\n\n");
    for (const { key, content } of changed) lastInjected.set(key, content);
    if (changed.length)
      notify(`Injected at-mention context: ${changed.map(({ raw }) => raw).join(", ")}`, "info");
    const suffix = appendInlineContext("", content);
    const lastText =
      typeof message.content === "string"
        ? -1
        : message.content.map((part) => part.type).lastIndexOf("text");
    return {
      message: {
        ...message,
        content:
          typeof message.content === "string"
            ? message.content + suffix
            : message.content.map((part, index) =>
                index === lastText && part.type === "text"
                  ? { ...part, text: part.text + suffix }
                  : part,
              ),
      },
    };
  });
}
