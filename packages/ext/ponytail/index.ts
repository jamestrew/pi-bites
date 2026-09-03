import { existsSync, readFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const PONYTAIL_BLOCK_START = "<pi-bites-ponytail>";
const PONYTAIL_BLOCK_END = "</pi-bites-ponytail>";
const PONYTAIL_BLOCK_PATTERN = /\n\n<pi-bites-ponytail>[\s\S]*?<\/pi-bites-ponytail>/g;

export type PonytailPromptPreview = (systemPrompt: string) => string;

export interface PonytailEnabledEntry {
  enabled: boolean;
}

function isPonytailEnabledEntry(value: unknown): value is PonytailEnabledEntry {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "enabled" in value &&
    typeof value.enabled === "boolean"
  );
}

function isDeactivationCommand(text: unknown): boolean {
  const trimmed = (typeof text === "string" ? text : "")
    .trim()
    .toLowerCase()
    .replace(/[.!?\s]+$/, "");
  return trimmed === "stop ponytail" || trimmed === "normal mode";
}

export function resolveSessionEnabled(entries: unknown): boolean {
  if (!Array.isArray(entries)) return true;
  const list = entries as unknown[];

  for (let i = list.length - 1; i >= 0; i -= 1) {
    const entry = list[i];
    if (
      typeof entry !== "object" ||
      entry === null ||
      !("type" in entry) ||
      !("customType" in entry) ||
      !("data" in entry) ||
      entry.type !== "custom" ||
      entry.customType !== "ponytail-enabled"
    )
      continue;
    const parsed = isPonytailEnabledEntry(entry.data) ? entry.data : undefined;
    return parsed?.enabled ?? true;
  }

  return true;
}

const skillPath = new URL("./skills/ponytail/SKILL.md", import.meta.url);

function readSkillBody(body: string): string {
  return String(body || "")
    .replace(/^---[\s\S]*?---\s*/, "")
    .trim();
}

function getPonytailInstructions(): string {
  try {
    if (existsSync(skillPath)) {
      return `PONYTAIL ACTIVE\n\n${readSkillBody(readFileSync(skillPath, "utf8"))}`;
    }
  } catch {
    // Fall through to compact built-in instructions.
  }

  return "PONYTAIL ACTIVE\n\nUse the shortest solution that actually works: YAGNI first, existing code second, stdlib/native features before custom code or new dependencies. Shortest working diff wins, but never skip understanding, security, validation, data-loss handling, accessibility, or explicit user requirements.";
}

export function previewPonytailPrompt(systemPrompt: string, currentInstructions?: string): string {
  const block = currentInstructions
    ? `\n\n${PONYTAIL_BLOCK_START}\n${currentInstructions}\n${PONYTAIL_BLOCK_END}`
    : "";
  const matches = [...systemPrompt.matchAll(PONYTAIL_BLOCK_PATTERN)];
  if (matches.length === 0) return block ? `${systemPrompt}${block}` : systemPrompt;
  const firstOffset = matches[0]?.index ?? -1;
  return systemPrompt.replace(PONYTAIL_BLOCK_PATTERN, (_owned, offset: number) =>
    block && offset === firstOffset ? block : "",
  );
}

export default function registerPonytail(pi: ExtensionAPI): PonytailPromptPreview {
  let enabled = true;

  function setEnabled(nextEnabled: boolean, ctx?: ExtensionContext): void {
    enabled = nextEnabled;
    pi.appendEntry("ponytail-enabled", { enabled } satisfies PonytailEnabledEntry);
    ctx?.ui.notify(`Ponytail ${enabled ? "enabled" : "disabled"}.`, "info");
  }

  pi.registerCommand("ponytail", {
    description: "Enable or disable Ponytail: on, off, status",
    getArgumentCompletions: (prefix) =>
      ["on", "off", "status"]
        .filter((v) => v.startsWith(prefix))
        .map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();
      if (!action || action === "on") return setEnabled(true, ctx);
      if (action === "off") return setEnabled(false, ctx);
      if (action === "status")
        return ctx.ui.notify(`Ponytail is ${enabled ? "enabled" : "disabled"}.`, "info");
      ctx.ui.notify("Unknown /ponytail command. Use on, off, or status.", "warning");
    },
  });

  pi.on("input", async (event) => {
    if (event.source === "extension") return;
    if (enabled && isDeactivationCommand(event.text)) setEnabled(false);
  });

  pi.on("session_start", async (_event, ctx) => {
    const entries = ctx.sessionManager.getBranch();
    enabled = resolveSessionEnabled(entries);
    ctx.ui.notify(`Ponytail loaded: ${enabled ? "on" : "off"}`, "info");
  });

  const previewPrompt: PonytailPromptPreview = (systemPrompt) =>
    previewPonytailPrompt(systemPrompt, enabled ? getPonytailInstructions() : undefined);

  pi.on("before_agent_start", async (event) => ({
    systemPrompt: previewPrompt(event.systemPrompt),
  }));

  return previewPrompt;
}
