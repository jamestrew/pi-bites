import { existsSync, readFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  isPonytailMode,
  loadConfig,
  writePonytailDefaultMode,
  type BitesConfig,
  type PonytailMode,
} from "../config.js";

const DEFAULT_MODE = "full" satisfies PonytailMode;
const PONYTAIL_BLOCK_START = "<pi-bites-ponytail>";
const PONYTAIL_BLOCK_END = "</pi-bites-ponytail>";
const PONYTAIL_BLOCK_PATTERN = /\n\n<pi-bites-ponytail>[\s\S]*?<\/pi-bites-ponytail>/g;

export type PonytailPromptPreview = (systemPrompt: string) => string;
const RUNTIME_MODES = ["off", "lite", "full", "ultra"] as const;
type RuntimeMode = (typeof RUNTIME_MODES)[number];

export interface PonytailModeEntry {
  mode: PonytailMode;
}

function isPonytailModeEntry(value: unknown): value is PonytailModeEntry {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "mode" in value &&
    isPonytailMode(value.mode)
  );
}

export function parsePonytailModeEntry(value: unknown): PonytailModeEntry | undefined {
  return isPonytailModeEntry(value) ? value : undefined;
}

function normalizeConfigMode(mode: unknown): PonytailMode | null {
  if (typeof mode !== "string") return null;
  const normalized = mode.trim().toLowerCase();
  return isPonytailMode(normalized) ? normalized : null;
}

function normalizeMode(mode: unknown): RuntimeMode | null {
  if (typeof mode !== "string") return null;
  const normalized = mode.trim().toLowerCase() as RuntimeMode;
  return RUNTIME_MODES.includes(normalized) ? normalized : null;
}

function getDefaultMode(config: BitesConfig): PonytailMode {
  return config.ponytail?.defaultMode ?? DEFAULT_MODE;
}

function isDeactivationCommand(text: unknown): boolean {
  const trimmed = (typeof text === "string" ? text : "")
    .trim()
    .toLowerCase()
    .replace(/[.!?\s]+$/, "");
  return trimmed === "stop ponytail" || trimmed === "normal mode";
}

export function resolveSessionMode(
  entries: unknown,
  fallbackMode: PonytailMode = DEFAULT_MODE,
): PonytailMode {
  const fallback = fallbackMode;
  if (!Array.isArray(entries)) return fallback;
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
      entry.customType !== "ponytail-mode"
    )
      continue;
    const persisted = parsePonytailModeEntry(entry.data);
    if (persisted) return persisted.mode;
  }

  return fallback;
}

export function parsePonytailCommand(text: string, defaultMode: PonytailMode = DEFAULT_MODE) {
  const fallback = defaultMode;
  const normalizedText = String(text || "")
    .trim()
    .toLowerCase();

  if (!normalizedText)
    return { type: "set-mode", mode: fallback === "off" ? "full" : fallback } as const;

  const [primary, secondary] = normalizedText.split(/\s+/);
  if (primary === "status") return { type: "status" } as const;
  if (primary === "default") {
    const mode = normalizeConfigMode(secondary);
    return mode ? ({ type: "set-default", mode } as const) : ({ type: "invalid" } as const);
  }

  const mode = normalizeMode(primary);
  return mode ? ({ type: "set-mode", mode } as const) : ({ type: "invalid" } as const);
}

const skillPath = new URL("./skills/ponytail/SKILL.md", import.meta.url);

export function filterSkillBodyForMode(body: string, mode: RuntimeMode): string {
  return String(body || "")
    .replace(/^---[\s\S]*?---\s*/, "")
    .split(/\r?\n/)
    .filter((line) => {
      const tableLabel = line.match(/^\|\s*\*\*(.+?)\*\*\s*\|/);
      if (tableLabel) {
        const labelMode = normalizeMode(tableLabel[1]?.trim());
        if (labelMode) return labelMode === mode;
      }

      const exampleLabel = line.match(/^-\s*([^:]+):\s*/);
      if (exampleLabel) {
        const labelMode = normalizeMode(exampleLabel[1]?.trim());
        if (labelMode) return labelMode === mode;
      }

      return true;
    })
    .join("\n");
}

function getPonytailInstructions(mode: PonytailMode): string {
  if (mode === "review") {
    return "PONYTAIL MODE ACTIVE — level: review. Behavior defined by /ponytail-review skill.";
  }

  const effectiveMode = normalizeMode(mode) ?? DEFAULT_MODE;
  try {
    if (existsSync(skillPath)) {
      return `PONYTAIL MODE ACTIVE — level: ${effectiveMode}\n\n${filterSkillBodyForMode(readFileSync(skillPath, "utf8"), effectiveMode)}`;
    }
  } catch {
    // Fall through to compact built-in instructions.
  }

  return `PONYTAIL MODE ACTIVE — level: ${effectiveMode}\n\nUse the laziest solution that actually works: YAGNI first, existing code second, stdlib/native features before custom code or new dependencies. Shortest working diff wins, but never skip understanding, security, validation, data-loss handling, accessibility, or explicit user requirements.`;
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

function sendAlias(pi: ExtensionAPI, skillName: string, ctx: ExtensionContext): void {
  if (ctx.isIdle() === false) {
    pi.sendUserMessage(skillName, { deliverAs: "followUp" });
    ctx.ui.notify(`${skillName} queued as follow-up.`, "info");
    return;
  }
  pi.sendUserMessage(skillName);
}

function dimStatus(ctx: ExtensionContext, text: string): string {
  try {
    return ctx.ui.theme.fg("dim", text);
  } catch {
    return text;
  }
}

export default function registerPonytail(
  pi: ExtensionAPI,
  configRef: { current: BitesConfig } = { current: {} },
): PonytailPromptPreview {
  let currentMode: PonytailMode = DEFAULT_MODE;
  let configuredDefaultMode = getDefaultMode(configRef.current);
  let isActive = false;
  let lastCtx: ExtensionContext | undefined;

  function syncStatus(ctx?: ExtensionContext): void {
    if (ctx) lastCtx = ctx;
    const target = ctx ?? lastCtx;
    if (!target) return;
    if (currentMode === "off") return target.ui.setStatus("ponytail", undefined);
    const icons: Record<string, string> = { lite: "🌿", full: "⚡", ultra: "🔥", review: "🔎" };
    target.ui.setStatus(
      "ponytail",
      dimStatus(
        target,
        `${isActive ? "●" : "○"} 🐴 ponytail: ${icons[currentMode] ?? ""} ${currentMode.toUpperCase()}`,
      ),
    );
  }

  function setMode(mode: PonytailMode, ctx?: ExtensionContext): void {
    currentMode = mode;
    pi.appendEntry("ponytail-mode", { mode } satisfies PonytailModeEntry);
    syncStatus(ctx);
    ctx?.ui.notify(`Ponytail mode set to ${mode}.`, "info");
  }

  pi.registerCommand("ponytail", {
    description: "Set Ponytail mode: lite, full, ultra, off, status, default <mode>",
    getArgumentCompletions: (prefix) =>
      ["lite", "full", "ultra", "off", "status", "default"]
        .filter((v) => v.startsWith(prefix))
        .map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      const parsed = parsePonytailCommand(args, configuredDefaultMode);
      if (parsed.type === "status")
        return ctx.ui.notify(
          `Ponytail: current ${currentMode} • default ${configuredDefaultMode}`,
          "info",
        );
      if (parsed.type === "set-default") {
        writePonytailDefaultMode(ctx.cwd, parsed.mode);
        configRef.current = loadConfig(ctx.cwd);
        configuredDefaultMode = getDefaultMode(configRef.current);
        return ctx.ui.notify(`Default Ponytail mode set to ${configuredDefaultMode}.`, "info");
      }
      if (parsed.type === "set-mode") return setMode(parsed.mode, ctx);
      ctx.ui.notify(
        "Unknown /ponytail mode. Use lite, full, ultra, off, status, or default <mode>.",
        "warning",
      );
    },
  });

  for (const name of [
    "ponytail-review",
    "ponytail-audit",
    "ponytail-gain",
    "ponytail-debt",
    "ponytail-help",
  ]) {
    pi.registerCommand(name, {
      description: `Run /skill:${name}`,
      handler: async (_args, ctx) => sendAlias(pi, `/skill:${name}`, ctx),
    });
  }

  pi.on("input", async (event) => {
    if (event.source === "extension") return;
    if (currentMode !== "off" && isDeactivationCommand(event.text)) setMode("off");
  });

  pi.on("session_start", async (_event, ctx) => {
    const entries = ctx.sessionManager.getBranch();
    configuredDefaultMode = getDefaultMode(configRef.current);
    currentMode = resolveSessionMode(entries, configuredDefaultMode);
    syncStatus(ctx);
    ctx.ui.notify(`Ponytail loaded: ${currentMode}`, "info");
  });

  pi.on("agent_start", async (_event, ctx) => {
    isActive = true;
    syncStatus(ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    isActive = false;
    syncStatus(ctx);
  });

  const previewPrompt: PonytailPromptPreview = (systemPrompt) =>
    previewPonytailPrompt(
      systemPrompt,
      currentMode === "off" ? undefined : getPonytailInstructions(currentMode),
    );

  pi.on("before_agent_start", async (event) => ({
    systemPrompt: previewPrompt(event.systemPrompt),
  }));

  return previewPrompt;
}
