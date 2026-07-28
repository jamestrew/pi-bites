import {
  estimateTokens,
  formatSkillsForPrompt,
  sessionEntryToContextMessages,
  type BuildSystemPromptOptions,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type Theme,
  type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { formatTokens } from "./footer/index.js";
import type { PonytailPromptPreview } from "./ponytail/index.js";

export interface ContextPart {
  label: string;
  tokens: number;
  details?: Array<{ label: string; tokens: number }>;
}

export interface ContextBreakdown {
  total: number;
  window: number;
  parts: ContextPart[];
}

const estimateText = (text: string): number => Math.ceil(text.length / 4);

function distribute(total: number, items: Array<{ label: string; weight: number }>) {
  const weight = items.reduce((sum, item) => sum + item.weight, 0);
  return items.map((item) => ({
    label: item.label,
    tokens: weight === 0 ? 0 : Math.round((total * item.weight) / weight),
  }));
}

function contextFileDetails(options: BuildSystemPromptOptions) {
  return (options.contextFiles ?? []).map((file) => ({
    label: file.path,
    tokens: estimateText(
      `<project_instructions path="${file.path}">\n${file.content}\n</project_instructions>`,
    ),
  }));
}

function skillDetails(options: BuildSystemPromptOptions): Array<{ label: string; tokens: number }> {
  const skills = (options.skills ?? []).filter((skill) => !skill.disableModelInvocation);
  const hasRead = !options.selectedTools || options.selectedTools.includes("read");
  if (!hasRead || skills.length === 0) return [];
  const total = estimateText(formatSkillsForPrompt(skills));
  return distribute(
    total,
    skills.map((skill) => ({
      label: skill.name,
      weight: `${skill.name}${skill.description}${skill.filePath}`.length,
    })),
  );
}

function estimateProviderToolTokens(tool: ToolInfo): number {
  // Provider-specific serialization is the accuracy ceiling; use Pi's canonical serializer if it becomes public.
  return estimateText(
    JSON.stringify({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    }),
  );
}

function toolDetails(tools: ToolInfo[], activeNames: string[]) {
  const active = new Set(activeNames);
  return tools
    .filter((tool) => active.has(tool.name))
    .map((tool) => ({ label: tool.name, tokens: estimateProviderToolTokens(tool) }));
}

export function buildContextBreakdown(input: {
  total: number | null;
  window: number;
  systemPrompt: string;
  options: BuildSystemPromptOptions;
  tools: ToolInfo[];
  activeTools: string[];
  messageTokens: number;
}): ContextBreakdown {
  const files = contextFileDetails(input.options);
  const skills = skillDetails(input.options);
  const tools = toolDetails(input.tools, input.activeTools);
  const fileTokens = files.reduce((sum, item) => sum + item.tokens, 0);
  const skillTokens = skills.reduce((sum, item) => sum + item.tokens, 0);
  const toolTokens = tools.reduce((sum, item) => sum + item.tokens, 0);
  const fullSystemTokens = estimateText(input.systemPrompt);
  const systemTokens = Math.max(0, fullSystemTokens - fileTokens - skillTokens);
  const estimatedTotal = fullSystemTokens + toolTokens + input.messageTokens;
  // Pi reports zero before the first model response, but static prompt and tool context already exists.
  const total = input.total === null || input.total === 0 ? estimatedTotal : input.total;

  return {
    total,
    window: input.window,
    parts: [
      { label: "System prompt", tokens: systemTokens },
      { label: "System tools", tokens: toolTokens, details: tools },
      { label: "Context files", tokens: fileTokens, details: files },
      { label: "Skills", tokens: skillTokens, details: skills },
      { label: "Messages", tokens: input.messageTokens },
    ],
  };
}

const PART_GLYPHS = ["⛀", "⛁", "⛂", "⛃", "⛒"];
const PART_COLORS = ["accent", "warning", "success", "mdLink", "text"] as const;

export function availableContextTokens(data: Pick<ContextBreakdown, "total" | "window">): number {
  return Math.max(0, data.window - data.total);
}

class ContextComponent {
  constructor(
    private readonly theme: Theme,
    private readonly data: ContextBreakdown,
    private readonly modelName: string,
    private readonly expanded: boolean,
    private readonly done: () => void,
  ) {}

  handleInput(input: string): void {
    if (matchesKey(input, "escape") || matchesKey(input, "q") || matchesKey(input, "enter")) {
      this.done();
    }
  }

  render(width: number): string[] {
    const all = [
      ...this.data.parts,
      { label: "Free space", tokens: availableContextTokens(this.data) },
    ];
    const glyphs = [...PART_GLYPHS, "⛶"];
    const colors = [...PART_COLORS, "dim"] as const;
    const cells: string[] = [];
    let boundary = 0;
    const boundaries = all.map((part) => (boundary += (part.tokens / this.data.window) * 100));
    for (let i = 0; i < 100; i++) {
      const category = Math.min(
        boundaries.findIndex((end) => i + 0.5 <= end),
        all.length - 1,
      );
      const safeCategory = category < 0 ? all.length - 1 : category;
      cells.push(this.theme.fg(colors[safeCategory] ?? "dim", glyphs[safeCategory] ?? "⛶"));
    }

    const percent = (tokens: number) => `${((tokens / this.data.window) * 100).toFixed(1)}%`;
    const lines = [
      this.theme.fg("accent", this.theme.bold("Context Usage")),
      this.theme.fg("muted", this.modelName),
      `${formatTokens(this.data.total)}/${formatTokens(this.data.window)} tokens (${Math.round((this.data.total / this.data.window) * 100)}%)`,
      "",
    ];
    for (let row = 0; row < 5; row++) lines.push(cells.slice(row * 20, row * 20 + 20).join(" "));
    lines.push("", this.theme.fg("muted", "Independent category estimates (may not sum to total)"));
    for (let i = 0; i < all.length; i++) {
      const part = all[i];
      if (!part) continue;
      const approximate = part.label === "Free space" ? "" : "~";
      lines.push(
        `${this.theme.fg(colors[i] ?? "dim", glyphs[i] ?? "⛶")} ${part.label}: ${approximate}${formatTokens(part.tokens)} tokens (${percent(part.tokens)})`,
      );
    }

    for (const part of this.data.parts.filter((item) => item.details)) {
      lines.push(
        "",
        `${part.label} · ${part.details?.length ?? 0} items · ~${formatTokens(part.tokens)} tokens`,
      );
      if (this.expanded) {
        for (const [index, item] of (part.details ?? []).entries()) {
          const branch = index === (part.details?.length ?? 0) - 1 ? "└" : "├";
          lines.push(`${branch} ${item.label}: ~${formatTokens(item.tokens)} tokens`);
        }
      }
    }
    if (!this.expanded) lines.push("", this.theme.fg("dim", "/context all to expand"));
    lines.push("", this.theme.fg("dim", "[q/esc/enter] close"));
    return lines.map((line) => truncateToWidth(line, Math.max(0, width)));
  }

  invalidate(): void {}
}

function estimateMessages(ctx: ExtensionCommandContext): number {
  return ctx.sessionManager
    .buildContextEntries()
    .flatMap(sessionEntryToContextMessages)
    .reduce((sum, message) => sum + estimateTokens(message), 0);
}

export default function registerContext(
  pi: ExtensionAPI,
  previewPrompt?: PonytailPromptPreview,
  previewTools?: (tools: ToolInfo[], activeNames: string[]) => ToolInfo[],
): void {
  pi.registerCommand("context", {
    description: "Show estimated context window usage",
    getArgumentCompletions: (prefix) =>
      "all".startsWith(prefix.trim())
        ? [{ value: "all", label: "all", description: "Show item details" }]
        : null,
    handler: async (args, ctx) => {
      const argument = args.trim();
      if (argument && argument !== "all") {
        ctx.ui.notify("Usage: /context [all]", "warning");
        return;
      }
      if (ctx.mode !== "tui" || !ctx.model) return;
      const usage = ctx.getContextUsage();
      const currentSystemPrompt = ctx.getSystemPrompt();
      const systemPrompt = previewPrompt?.(currentSystemPrompt) ?? currentSystemPrompt;
      const tools = pi.getAllTools();
      const activeTools = pi.getActiveTools();
      const data = buildContextBreakdown({
        total: usage?.tokens ?? null,
        window: usage?.contextWindow ?? ctx.model.contextWindow,
        systemPrompt,
        options: ctx.getSystemPromptOptions(),
        tools: previewTools?.(tools, activeTools) ?? tools,
        activeTools,
        messageTokens: estimateMessages(ctx),
      });
      await ctx.ui.custom<void>(
        (_tui, theme, _kb, done) =>
          new ContextComponent(
            theme,
            data,
            ctx.model?.name ?? ctx.model?.id ?? "Unknown model",
            argument === "all",
            done,
          ),
      );
    },
  });
}
