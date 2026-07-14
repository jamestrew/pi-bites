import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  stripFrontmatter,
  type ExtensionAPI,
  type PromptTemplate,
} from "@earendil-works/pi-coding-agent";
import {
  fuzzyFilter,
  type AutocompleteItem,
  type AutocompleteProvider,
} from "@earendil-works/pi-tui";

type InlineReferenceKind = "skill" | "prompt";

type InlineReference = {
  kind: InlineReferenceKind;
  name: string;
  raw: string;
};

type LoadedPromptTemplate = Pick<PromptTemplate, "name" | "description" | "content" | "filePath">;

type SlashCommandLike = {
  name?: string;
  value?: string;
  label?: string;
  description?: string;
  getArgumentCompletions?: unknown;
};

const BUILTIN_COMMAND_NAMES = new Set([
  "settings",
  "model",
  "scoped-models",
  "export",
  "import",
  "share",
  "copy",
  "name",
  "session",
  "changelog",
  "hotkeys",
  "fork",
  "clone",
  "tree",
  "trust",
  "login",
  "logout",
  "new",
  "compact",
  "resume",
  "reload",
  "quit",
]);

function isReferenceBoundary(char: string | undefined): boolean {
  return char === undefined || /\s/.test(char);
}

export function parseInlineReferences(text: string): InlineReference[] {
  const refs: InlineReference[] = [];

  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "$" || !isReferenceBoundary(text[i - 1])) continue;

    const match = text.slice(i).match(/^\$(skill|prompt):([^\s]+)/);
    if (!match) continue;

    const kind = match[1] as InlineReferenceKind;
    const name = match[2]!.replace(/[),.;!?]+$/, "");
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

function findDollarPrefix(textBeforeCursor: string): string | null {
  return textBeforeCursor.match(/(?:^|[ \t])(\$[^\s]*)$/)?.[1] ?? null;
}

function loadDefaultPromptTemplates(cwd: string): LoadedPromptTemplate[] {
  const dirs = [join(getAgentDir(), "prompts"), join(cwd, CONFIG_DIR_NAME, "prompts")];
  const templates: LoadedPromptTemplate[] = [];

  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const filePath = join(dir, entry.name);
      const content = readFileSync(filePath, "utf-8");
      const body = stripFrontmatter(content).trim();
      const description =
        body
          .split("\n")
          .find((line) => line.trim().length > 0)
          ?.trim() ?? "";
      templates.push({
        name: basename(entry.name, ".md"),
        description,
        content: body,
        filePath,
      });
    }
  }

  return templates;
}

function formatSkillBlock(skill: { name: string; filePath: string; baseDir: string }): string {
  const content = readFileSync(skill.filePath, "utf-8");
  const body = stripFrontmatter(content).trim();
  return `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
}

function formatPromptBlock(prompt: LoadedPromptTemplate): string {
  return `<prompt name="${prompt.name}" location="${prompt.filePath}">\n${prompt.content.trim()}\n</prompt>`;
}

function patchLoadedReferencePrompt(systemPrompt: string): string {
  const readInstruction =
    "Use the read tool to load a skill's file when the task matches its description.";
  const loadedInstruction =
    "Use the read tool to load a skill's file when the task matches its description, unless hidden inline-reference-context has already provided that skill. Treat provided inline-reference-context as already loaded; only read referenced files when needed.";

  if (systemPrompt.includes(loadedInstruction)) return systemPrompt;
  if (systemPrompt.includes(readInstruction)) {
    return systemPrompt.replace(readInstruction, loadedInstruction);
  }

  return `${systemPrompt}\n\nInline reference note: when hidden skill-context or prompt-context is provided, treat it as already loaded; do not read the referenced source file again unless you need to inspect referenced files.`;
}

function registerInlineReferenceContext(pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event, ctx) => {
    const refs = parseInlineReferences(event.prompt);
    if (refs.length === 0) return;

    const skills = refs
      .filter((ref) => ref.kind === "skill")
      .map((ref) => event.systemPromptOptions.skills?.find((skill) => skill.name === ref.name))
      .filter((skill) => skill !== undefined);

    const loadedPrompts = loadDefaultPromptTemplates(ctx.cwd);
    const prompts = refs
      .filter((ref) => ref.kind === "prompt")
      .map((ref) => loadedPrompts.find((prompt) => prompt.name === ref.name))
      .filter((prompt) => prompt !== undefined);

    const blocks = [...skills.map(formatSkillBlock), ...prompts.map(formatPromptBlock)];
    if (blocks.length === 0)
      return { systemPrompt: patchLoadedReferencePrompt(event.systemPrompt) };

    return {
      message: {
        customType: "inline-reference-context",
        content: blocks.join("\n\n"),
        display: false,
        details: refs.map((ref) => ref.raw).join(", "),
      },
      systemPrompt: patchLoadedReferencePrompt(event.systemPrompt),
    };
  });
}

function slashCommandName(command: SlashCommandLike): string {
  return command.name ?? command.value ?? "";
}

function isPromptTemplateCommand(command: SlashCommandLike): boolean {
  const name = slashCommandName(command);
  if (!name || name.includes(":") || BUILTIN_COMMAND_NAMES.has(name)) return false;

  // Pi's base provider orders and shapes commands as:
  // built-ins, prompt templates, extension commands, skills.
  // Extension commands always carry this property, even when the value is undefined.
  return !("getArgumentCompletions" in command);
}

function referenceItemFromCommand(command: SlashCommandLike): AutocompleteItem | null {
  const name = slashCommandName(command);
  if (name.startsWith("skill:")) {
    return {
      value: `$${name}`,
      label: `$${name}`,
      ...(command.description !== undefined && { description: command.description }),
    };
  }
  if (isPromptTemplateCommand(command)) {
    return {
      value: `$prompt:${name}`,
      label: `$prompt:${name}`,
      ...(command.description !== undefined && { description: command.description }),
    };
  }
  return null;
}

function referenceItems(current: AutocompleteProvider): AutocompleteItem[] {
  const commands = (current as unknown as { commands?: SlashCommandLike[] }).commands ?? [];
  return commands
    .map(referenceItemFromCommand)
    .filter((item): item is AutocompleteItem => item !== null);
}

function isPathLikeSuggestion(item: AutocompleteItem): boolean {
  return item.value.includes("/") || item.value.startsWith(".");
}

function referenceItemFromSlashSuggestion(
  item: AutocompleteItem,
  promptNames: Set<string>,
): AutocompleteItem | null {
  if (isPathLikeSuggestion(item)) return null;
  if (item.value.startsWith("skill:")) {
    return {
      value: `$${item.value}`,
      label: `$${item.value}`,
      ...(item.description !== undefined && { description: item.description }),
    };
  }
  if (promptNames.has(item.value)) {
    return {
      value: `$prompt:${item.value}`,
      label: `$prompt:${item.value}`,
      ...(item.description !== undefined && { description: item.description }),
    };
  }
  return null;
}

async function referenceItemsFromSlashProvider(
  current: AutocompleteProvider,
  signal: AbortSignal,
  promptNames: Set<string>,
): Promise<AutocompleteItem[]> {
  const suggestions = await current.getSuggestions(["/"], 0, 1, { signal, force: false });
  return (suggestions?.items ?? [])
    .map((item) => referenceItemFromSlashSuggestion(item, promptNames))
    .filter((item): item is AutocompleteItem => item !== null);
}

async function dollarSuggestions(
  current: AutocompleteProvider,
  dollarPrefix: string,
  signal: AbortSignal,
  promptNames: Set<string>,
) {
  let items = referenceItems(current);
  if (items.length === 0) {
    items = await referenceItemsFromSlashProvider(current, signal, promptNames);
  }
  if (dollarPrefix.startsWith("$skill:")) {
    items = items.filter((item) => item.value.startsWith("$skill:"));
  } else if (dollarPrefix.startsWith("$prompt:")) {
    items = items.filter((item) => item.value.startsWith("$prompt:"));
  }

  const filtered = fuzzyFilter(items, dollarPrefix, (item) => item.value);
  return filtered.length === 0 ? null : { items: filtered, prefix: dollarPrefix };
}

function registerDollarAutocomplete(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    const promptNames = new Set(loadDefaultPromptTemplates(ctx.cwd).map((prompt) => prompt.name));
    ctx.ui.addAutocompleteProvider((current) => {
      const currentWithTriggers = current as AutocompleteProvider & {
        triggerCharacters?: string[];
      };
      return {
        ...current,
        triggerCharacters: [...(currentWithTriggers.triggerCharacters ?? []), "$"],
        async getSuggestions(lines, cursorLine, cursorCol, options) {
          const currentLine = lines[cursorLine] ?? "";
          const beforeCursor = currentLine.slice(0, cursorCol);
          const dollarPrefix = findDollarPrefix(beforeCursor);
          if (dollarPrefix)
            return dollarSuggestions(current, dollarPrefix, options.signal, promptNames);
          return current.getSuggestions(lines, cursorLine, cursorCol, options);
        },
        applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
          if (prefix.startsWith("$")) {
            const currentLine = lines[cursorLine] ?? "";
            const beforePrefix = currentLine.slice(0, cursorCol - prefix.length);
            const afterCursor = currentLine.slice(cursorCol);
            const newLines = [...lines];
            newLines[cursorLine] = `${beforePrefix}${item.value} ${afterCursor}`;
            return {
              lines: newLines,
              cursorLine,
              cursorCol: beforePrefix.length + item.value.length + 1,
            };
          }
          return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
        },
      };
    });
  });
}

export default function registerInlineReferences(pi: ExtensionAPI) {
  registerDollarAutocomplete(pi);
  registerInlineReferenceContext(pi);
}
