import { readFileSync } from "node:fs";
import { AgentSession, stripFrontmatter, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CombinedAutocompleteProvider, Editor, fuzzyFilter } from "@earendil-works/pi-tui";

type AutocompleteOptions = { signal: AbortSignal; force?: boolean };
type AutocompleteItem = { value: string; label?: string; description?: string };
type Suggestions = { items: AutocompleteItem[]; prefix: string } | null;
type CommandLike = {
  name?: string;
  value?: string;
  label?: string;
  description?: string;
  argumentHint?: string;
};

type ProviderLike = {
  commands?: CommandLike[];
  getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: AutocompleteOptions,
  ): Promise<Suggestions>;
  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ): { lines: string[]; cursorLine: number; cursorCol: number };
};

type EditorLike = {
  state: { lines: string[]; cursorLine: number; cursorCol: number };
  tryTriggerAutocomplete(explicitTab?: boolean): void;
  handleSlashCommandCompletion(): void;
  forceFileAutocomplete(explicitTab?: boolean): void;
};

// Why prototype patches instead of ctx.ui.addAutocompleteProvider?
//
// pi's public autocomplete hook can layer suggestions on top of the built-in provider,
// but the editor decides when slash completion is active before/around that provider.
// In current pi, slash completion is hardcoded to the first line and to text that
// starts with `/`; inline text like `use /skill:handoff` is treated as normal text
// or file completion. The editor methods that control this (`isSlashMenuAllowed`,
// `isInSlashCommandContext`, `handleTabCompletion`, etc.) are private internals,
// not extension hooks.
//
// Skill expansion is also private (`AgentSession._expandSkillCommand`). To hide
// pi's normal visible `/skill:` expansion and inject hidden skill-context instead,
// this extension has to patch that private method too.
//
// These patches are intentionally narrow and guarded with Symbol flags so reloads
// do not stack wrappers, but they are still monkey patches over pi internals.
const EDITOR_PATCHED = Symbol.for("pi-bites.slash-skill-autocomplete.editor-patched");
const PROVIDER_PATCHED = Symbol.for("pi-bites.slash-skill-autocomplete.provider-patched");
const SKILL_EXPANSION_PATCHED = Symbol.for(
  "pi-bites.slash-skill-autocomplete.skill-expansion-hidden-v1",
);

function commandName(command: CommandLike): string {
  return command.name ?? command.value ?? "";
}

function findSlashPrefix(textBeforeCursor: string): string | null {
  return textBeforeCursor.match(/(?:^|[ \t])(\/[^\s]*)$/)?.[1] ?? null;
}

function skillSuggestions(commands: CommandLike[], slashPrefix: string): Suggestions {
  const query = slashPrefix.slice(1);
  const skillCommands = commands
    .filter((command) => commandName(command).startsWith("skill:"))
    .map((command) => {
      const name = commandName(command);
      const hint = command.argumentHint ? command.argumentHint : undefined;
      const desc = command.description ?? "";
      const fullDesc = hint ? (desc ? `${hint} — ${desc}` : hint) : desc;
      return { name, label: command.label ?? name, description: fullDesc || undefined };
    });

  const items = fuzzyFilter(skillCommands, query, (item) => item.name).map((item) => ({
    value: item.name,
    label: item.label,
    ...(item.description ? { description: item.description } : {}),
  }));

  return items.length === 0 ? null : { items, prefix: slashPrefix };
}

function patchEditor() {
  const proto = Editor.prototype as unknown as EditorLike & Record<PropertyKey, unknown>;
  if (proto[EDITOR_PATCHED]) return;
  proto[EDITOR_PATCHED] = true;

  proto.isSlashMenuAllowed = () => true;
  proto.isAtStartOfMessage = function () {
    const line = this.state.lines[this.state.cursorLine] ?? "";
    const beforeCursor = line.slice(0, this.state.cursorCol);
    return beforeCursor.trim() === "" || /(?:^|[ \t])\/$/.test(beforeCursor);
  };
  proto.isInSlashCommandContext = function (textBeforeCursor: string) {
    return findSlashPrefix(textBeforeCursor) !== null;
  };
  proto.handleTabCompletion = function () {
    const line = this.state.lines[this.state.cursorLine] ?? "";
    const beforeCursor = line.slice(0, this.state.cursorCol);
    const slashPrefix = findSlashPrefix(beforeCursor);
    if (slashPrefix && !slashPrefix.includes(" ")) {
      this.handleSlashCommandCompletion();
    } else {
      this.forceFileAutocomplete(true);
    }
  };
}

function patchAutocompleteProvider() {
  const proto = CombinedAutocompleteProvider.prototype as unknown as ProviderLike &
    Record<PropertyKey, unknown>;
  if (proto[PROVIDER_PATCHED]) return;
  proto[PROVIDER_PATCHED] = true;

  const originalGetSuggestions = proto.getSuggestions;
  proto.getSuggestions = async function (lines, cursorLine, cursorCol, options) {
    const currentLine = lines[cursorLine] ?? "";
    const beforeCursor = currentLine.slice(0, cursorCol);
    const slashPrefix = findSlashPrefix(beforeCursor);

    if (!options.force && slashPrefix && !beforeCursor.startsWith("/")) {
      return skillSuggestions(this.commands ?? [], slashPrefix);
    }

    return originalGetSuggestions.call(this, lines, cursorLine, cursorCol, options);
  };

  const originalApplyCompletion = proto.applyCompletion;
  proto.applyCompletion = function (lines, cursorLine, cursorCol, item, prefix) {
    const currentLine = lines[cursorLine] ?? "";
    const beforePrefix = currentLine.slice(0, cursorCol - prefix.length);
    if (prefix.startsWith("/") && beforePrefix.trim() !== "" && !prefix.slice(1).includes("/")) {
      const afterCursor = currentLine.slice(cursorCol);
      const newLines = [...lines];
      newLines[cursorLine] = `${beforePrefix}/${item.value} ${afterCursor}`;
      return {
        lines: newLines,
        cursorLine,
        cursorCol: beforePrefix.length + item.value.length + 2,
      };
    }

    return originalApplyCompletion.call(this, lines, cursorLine, cursorCol, item, prefix);
  };
}

function patchSkillExpansion() {
  const proto = AgentSession.prototype as unknown as Record<PropertyKey, unknown>;
  if (proto[SKILL_EXPANSION_PATCHED]) return;
  proto[SKILL_EXPANSION_PATCHED] = true;

  proto._expandSkillCommand = (text: string) => text;
}

function skillNamesInPrompt(prompt: string): string[] {
  const seen = new Set<string>();
  const names: string[] = [];

  for (const match of prompt.matchAll(/(^|\s)\/skill:([^\s]+)/g)) {
    const name = match[2];
    if (seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }

  return names;
}

function formatSkillBlock(skill: { name: string; filePath: string; baseDir: string }): string {
  const content = readFileSync(skill.filePath, "utf-8");
  const body = stripFrontmatter(content).trim();
  return `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
}

function patchLoadedSkillPrompt(systemPrompt: string): string {
  const readInstruction =
    "Use the read tool to load a skill's file when the task matches its description.";
  const loadedInstruction =
    "Use the read tool to load a skill's file when the task matches its description, unless hidden skill-context has already provided that skill. Treat provided skill-context as already loaded; only read referenced files when needed.";

  if (systemPrompt.includes(loadedInstruction)) return systemPrompt;
  if (systemPrompt.includes(readInstruction)) {
    return systemPrompt.replace(readInstruction, loadedInstruction);
  }

  return `${systemPrompt}\n\nSkill invocation note: when hidden skill-context is provided, treat that skill as already loaded; do not read its SKILL.md again unless you need to inspect referenced files.`;
}

function registerLoadedSkillPromptPatch(pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event) => {
    const names = skillNamesInPrompt(event.prompt);
    if (names.length === 0) return;

    const blocks = names
      .map((name) => event.systemPromptOptions.skills?.find((skill) => skill.name === name))
      .filter((skill) => skill !== undefined)
      .map((skill) => formatSkillBlock(skill));

    return {
      ...(blocks.length > 0
        ? {
            message: {
              customType: "skill-context",
              content: blocks.join("\n\n"),
              display: false,
              details: names.join(", "),
            },
          }
        : {}),
      systemPrompt: patchLoadedSkillPrompt(event.systemPrompt),
    };
  });
}

export default function registerSlashSkillAutocomplete(pi: ExtensionAPI) {
  patchEditor();
  patchAutocompleteProvider();
  patchSkillExpansion();
  registerLoadedSkillPromptPatch(pi);
}
