import { readFileSync } from "node:fs";
import { AgentSession, stripFrontmatter, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { CombinedAutocompleteProvider, Editor, fuzzyFilter } from "@mariozechner/pi-tui";

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

const PATCHED = Symbol.for("pi-bites.slash-skill-autocomplete.patched");

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
  if (proto[PATCHED]) return;
  proto[PATCHED] = true;

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
  if (proto[PATCHED]) return;
  proto[PATCHED] = true;

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
  if (proto[PATCHED]) return;
  proto[PATCHED] = true;

  const originalExpand = proto._expandSkillCommand as (this: AgentSession, text: string) => string;
  proto._expandSkillCommand = function (this: AgentSession, text: string) {
    if (text.startsWith("/skill:")) return originalExpand.call(this, text);
    if (!/(^|\s)\/skill:[^\s]+/.test(text)) return text;

    const session = this as unknown as {
      resourceLoader: {
        getSkills(): { skills: { name: string; filePath: string; baseDir: string }[] };
      };
      _extensionRunner: {
        emitError(error: { extensionPath: string; event: string; error: string }): void;
      };
    };

    return text.replace(/(^|\s)\/skill:([^\s]+)/g, (match, leading: string, skillName: string) => {
      const skill = session.resourceLoader
        .getSkills()
        .skills.find((candidate) => candidate.name === skillName);
      if (!skill) return match;

      try {
        const content = readFileSync(skill.filePath, "utf-8");
        const body = stripFrontmatter(content).trim();
        return `${leading}<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
      } catch (error) {
        session._extensionRunner.emitError({
          extensionPath: skill.filePath,
          event: "skill_expansion",
          error: error instanceof Error ? error.message : String(error),
        });
        return match;
      }
    });
  };
}

function hasExpandedSkillBlock(prompt: string): boolean {
  return /<skill\s+[^>]*location="[^"]+SKILL\.md"[^>]*>[\s\S]*?<\/skill>/.test(prompt);
}

function patchLoadedSkillPrompt(systemPrompt: string): string {
  const readInstruction =
    "Use the read tool to load a skill's file when the task matches its description.";
  const loadedInstruction =
    "Use the read tool to load a skill's file when the task matches its description, unless the user prompt already includes that skill's full <skill> block. Treat included <skill> blocks as already loaded; only read referenced files when needed.";

  if (systemPrompt.includes(loadedInstruction)) return systemPrompt;
  if (systemPrompt.includes(readInstruction)) {
    return systemPrompt.replace(readInstruction, loadedInstruction);
  }

  return `${systemPrompt}\n\nSkill invocation note: when the user prompt includes a full <skill> block, treat that skill as already loaded; do not read its SKILL.md again unless you need to inspect referenced files.`;
}

function registerLoadedSkillPromptPatch(pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event) => {
    if (!hasExpandedSkillBlock(event.prompt)) return;

    return {
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
