/**
 * Pi-bites configuration loader.
 *
 * Config is read from two optional JSON files, merged with project-local taking precedence:
 *   ~/.pi/agent/pi-bites.json   (global)
 *   <cwd>/.pi/pi-bites.json     (project-local)
 *
 * Example pi-bites.json:
 * ```json
 * {
 *   "smallModel": {
 *     "model": "github-copilot/claude-haiku-4.5",
 *     "thinking": "low"
 *   },
 *   "statusline": {
 *     "command": "python get_usage_limits.py"
 *   },
 *   "autoCompaction": {
 *     "thresholdTokens": 150000
 *   },
 *   "bashGate": {
 *     "rules": [
 *       { "cmd": "bun", "subcommands": ["test"] },
 *       { "cmd": "npm", "subcommands": ["test"] },
 *       { "cmd": "pytest" }
 *     ]
 *   },
 *   "subagents": {
 *     "explore": { "model": "anthropic/claude-sonnet-4-5" }
 *   }
 * }
 * ```
 *
 * Each top-level section is optional — omitted sections fall back to built-in defaults.
 * For bashGate.rules, providing an array adds extra gated rules on top of the
 * built-in destructive-command protections.
 *
 * Use `disable` to turn off individual extensions by name. Valid names:
 *   "bashGate" | "autoMode" | "rtk" | "footer" | "statusline" | "tokenCount" | "usageDashboard" | "context" | "tools" | "explore" | "fzf" | "notifications" | "autoCompaction" | "spotme" | "inlineReferences" | "slashSkillAutocomplete" | "promptNormalization" | "atMentionContext" | "sessionTracker" | "ponytail" | "view" | "goal"
 *
 * Global and project-local `disable` arrays are **unioned** — disabling something globally
 * suppresses it in every project.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

export interface SmallModelConfig {
  /** Cheap model for lightweight internal tasks. */
  model?: string;
  /** Thinking level for lightweight internal tasks. */
  thinking?: ThinkingLevel;
}

export interface StatuslineConfig {
  /** Shell command whose trimmed stdout is shown in the statusline. */
  command?: string;
}

export interface AutoCompactionConfig {
  /** Compact once the active context reaches this many tokens. Defaults to 150,000. */
  thresholdTokens?: number;
}

export interface AutoModeConfig {
  /** Route bash-gate prompts to a reviewer model by default. */
  enabled?: boolean;
  /** Reviewer model. Defaults to the active model. */
  model?: string;
  /** Reviewer thinking level. Defaults to low. */
  thinking?: ThinkingLevel;
  /** Reviewer policy. Defaults to the bundled safety policy. */
  policy?: string;
}

export const PONYTAIL_MODES = ["off", "lite", "full", "ultra", "review"] as const;
export type PonytailMode = (typeof PONYTAIL_MODES)[number];

export interface PonytailConfig {
  /** Default Ponytail mode for new sessions. */
  defaultMode?: PonytailMode;
}

export interface CodexAdapterConfig {
  /** Additional provider IDs that should use Codex-shaped tools. */
  providers?: string[];
}

export interface SubagentsConfig {
  /** Per-agent model overrides keyed by agent type. */
  [agentType: string]: { model?: string };
}

export interface NotificationsConfig {
  /** Shell command run when the agent loop ends; receives { cwd, message } on stdin. */
  command?: string;
}

export type OneOrMany<T> = T | T[];
export const BASH_GATE_REDIRECT_RULES = ["any-write", "append", "truncate"] as const;
export type BashGateRedirectRule = (typeof BASH_GATE_REDIRECT_RULES)[number];

export interface BashGateRule {
  cmd?: OneOrMany<string>;
  subcommands?: OneOrMany<string>;
  flagAny?: OneOrMany<string>;
  redirects?: BashGateRedirectRule;
  reason?: string;
}

export interface BashGateConfig {
  /** Extra rules added to the built-in destructive-command rules. */
  rules?: BashGateRule[];
}

export const EXTENSION_NAMES = [
  "bashGate",
  "rtk",
  "footer",
  "statusline",
  "tokenCount",
  "usageDashboard",
  "context",
  "tools",
  "explore",
  "fzf",
  "notifications",
  "autoCompaction",
  "autoMode",
  "spotme",
  "inlineReferences",
  "slashSkillAutocomplete",
  "promptNormalization",
  "atMentionContext",
  "sessionTracker",
  "ponytail",
  "subagents",
  "view",
  "goal",
  "codexAdapter",
] as const;

export type ExtensionName = (typeof EXTENSION_NAMES)[number];

export interface BitesConfig {
  smallModel?: SmallModelConfig;
  statusline?: StatuslineConfig;
  bashGate?: BashGateConfig;
  notifications?: NotificationsConfig;
  autoCompaction?: AutoCompactionConfig;
  autoMode?: AutoModeConfig;
  ponytail?: PonytailConfig;
  codexAdapter?: CodexAdapterConfig;
  subagents?: SubagentsConfig;
  /** Extension names disabled globally or for this project. */
  disable?: ExtensionName[];
}

const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOptional(
  value: Record<string, unknown>,
  key: string,
  check: (field: unknown) => boolean,
): boolean {
  return !(key in value) || check(value[key]);
}

function isStringList(value: unknown): boolean {
  return (
    typeof value === "string" ||
    (Array.isArray(value) && value.every((item) => typeof item === "string"))
  );
}

export function isPonytailMode(value: unknown): value is PonytailMode {
  return PONYTAIL_MODES.some((mode) => mode === value);
}

function isSmallModelConfig(value: unknown): value is SmallModelConfig {
  return (
    isRecord(value) &&
    isOptional(value, "model", (field) => typeof field === "string") &&
    isOptional(value, "thinking", (field) => THINKING_LEVELS.some((level) => level === field))
  );
}

function isStatuslineConfig(value: unknown): value is StatuslineConfig {
  return isRecord(value) && isOptional(value, "command", (field) => typeof field === "string");
}

function isAutoCompactionConfig(value: unknown): value is AutoCompactionConfig {
  return (
    isRecord(value) &&
    isOptional(
      value,
      "thresholdTokens",
      (field) => typeof field === "number" && Number.isInteger(field) && field > 0,
    )
  );
}

function isAutoModeConfig(value: unknown): value is AutoModeConfig {
  return (
    isRecord(value) &&
    isOptional(value, "enabled", (field) => typeof field === "boolean") &&
    isOptional(value, "model", (field) => typeof field === "string") &&
    isOptional(value, "thinking", (field) => THINKING_LEVELS.some((level) => level === field)) &&
    isOptional(value, "policy", (field) => typeof field === "string")
  );
}

function isPonytailConfig(value: unknown): value is PonytailConfig {
  return isRecord(value) && isOptional(value, "defaultMode", isPonytailMode);
}

function isCodexAdapterConfig(value: unknown): value is CodexAdapterConfig {
  return (
    isRecord(value) &&
    isOptional(
      value,
      "providers",
      (field) =>
        Array.isArray(field) &&
        field.every((provider) => typeof provider === "string" && provider.trim().length > 0),
    )
  );
}

function isSubagentsConfig(value: unknown): value is SubagentsConfig {
  return (
    isRecord(value) &&
    Object.values(value).every(
      (agent) =>
        isRecord(agent) && isOptional(agent, "model", (field) => typeof field === "string"),
    )
  );
}

function isNotificationsConfig(value: unknown): value is NotificationsConfig {
  return isRecord(value) && isOptional(value, "command", (field) => typeof field === "string");
}

function isBashGateRule(value: unknown): value is BashGateRule {
  return (
    isRecord(value) &&
    isOptional(value, "cmd", isStringList) &&
    isOptional(value, "subcommands", isStringList) &&
    isOptional(value, "flagAny", isStringList) &&
    isOptional(value, "redirects", (field) =>
      BASH_GATE_REDIRECT_RULES.some((rule) => rule === field),
    ) &&
    isOptional(value, "reason", (field) => typeof field === "string")
  );
}

function isBashGateConfig(value: unknown): value is BashGateConfig {
  return (
    isRecord(value) &&
    isOptional(value, "rules", (rules) => Array.isArray(rules) && rules.every(isBashGateRule))
  );
}

function isExtensionName(value: unknown): value is ExtensionName {
  return EXTENSION_NAMES.some((name) => name === value);
}

function isBitesConfig(value: unknown): value is BitesConfig {
  return (
    isRecord(value) &&
    isOptional(value, "smallModel", isSmallModelConfig) &&
    isOptional(value, "statusline", isStatuslineConfig) &&
    isOptional(value, "bashGate", isBashGateConfig) &&
    isOptional(value, "notifications", isNotificationsConfig) &&
    isOptional(value, "autoCompaction", isAutoCompactionConfig) &&
    isOptional(value, "autoMode", isAutoModeConfig) &&
    isOptional(value, "ponytail", isPonytailConfig) &&
    isOptional(value, "codexAdapter", isCodexAdapterConfig) &&
    isOptional(value, "subagents", isSubagentsConfig) &&
    isOptional(value, "disable", (field) => Array.isArray(field) && field.every(isExtensionName))
  );
}

export function parseBitesConfig(value: unknown): BitesConfig | undefined {
  return isBitesConfig(value) ? value : undefined;
}

function tryReadJson(filePath: string, label: string): BitesConfig {
  if (!existsSync(filePath)) return {};
  try {
    const config = parseBitesConfig(JSON.parse(readFileSync(filePath, "utf-8")));
    if (!config) throw new Error("config does not match the pi-bites schema");
    return config;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`pi-bites: failed to parse ${label} config at ${filePath}: ${message}`);
    return {};
  }
}

/**
 * Load and merge config from global and project-local files.
 * Project-local values override global values within each section.
 */
export function loadConfig(cwd: string): BitesConfig {
  const globalPath = join(getAgentDir(), "pi-bites.json");
  const projectPath = join(cwd, CONFIG_DIR_NAME, "pi-bites.json");

  const global = tryReadJson(globalPath, "global");
  const project = tryReadJson(projectPath, "project-local");

  const disableUnion: ExtensionName[] = [
    ...new Set([...(global.disable ?? []), ...(project.disable ?? [])]),
  ];

  return {
    smallModel: { ...global.smallModel, ...project.smallModel },
    statusline: { ...global.statusline, ...project.statusline },
    bashGate: { ...global.bashGate, ...project.bashGate },
    notifications: { ...global.notifications, ...project.notifications },
    autoCompaction: { ...global.autoCompaction, ...project.autoCompaction },
    autoMode: { ...global.autoMode, ...project.autoMode },
    ponytail: { ...global.ponytail, ...project.ponytail },
    codexAdapter: { ...global.codexAdapter, ...project.codexAdapter },
    subagents: { ...global.subagents, ...project.subagents },
    ...(disableUnion.length > 0 ? { disable: disableUnion } : {}),
  };
}

// ---------------------------------------------------------------------------
// Config-file write helpers
// ---------------------------------------------------------------------------

/**
 * Resolve which config file to write to:
 * project-local (.pi/pi-bites.json) if it already exists, otherwise global.
 */
function resolveWritePath(cwd: string): string {
  const projectPath = join(cwd, CONFIG_DIR_NAME, "pi-bites.json");
  if (existsSync(projectPath)) return projectPath;
  return join(getAgentDir(), "pi-bites.json");
}

function readConfigFile(filePath: string): BitesConfig {
  return tryReadJson(filePath, filePath);
}

function writeConfigFile(filePath: string, config: BitesConfig): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

export function writePonytailDefaultMode(
  cwd: string,
  defaultMode: PonytailConfig["defaultMode"],
): void {
  const targetPath = resolveWritePath(cwd);
  const config = readConfigFile(targetPath);
  config.ponytail = { ...config.ponytail, defaultMode };
  writeConfigFile(targetPath, config);
}

// ---------------------------------------------------------------------------
// /bites:on, /bites:off, /bites:list commands
// ---------------------------------------------------------------------------

export function registerBitesCommands(pi: ExtensionAPI): void {
  const globalPath = join(getAgentDir(), "pi-bites.json");

  const completions = (prefix: string) =>
    EXTENSION_NAMES.filter((n) => n.startsWith(prefix)).map((n) => ({ value: n, label: n }));

  function validateName(
    name: string,
    ctx: { ui: { notify: (msg: string, type?: "error" | "info" | "warning") => void } },
  ): name is ExtensionName {
    if (!EXTENSION_NAMES.some((extensionName) => extensionName === name)) {
      ctx.ui.notify(
        `Unknown extension "${name}".\nValid names: ${EXTENSION_NAMES.join(", ")}`,
        "error",
      );
      return false;
    }
    return true;
  }

  // /bites:off ---------------------------------------------------------------
  pi.registerCommand("bites:off", {
    description: "Disable an extension by name (takes effect on next launch)",
    getArgumentCompletions: completions,
    handler: async (args, ctx) => {
      const name = args.trim();
      if (!validateName(name, ctx)) return;

      // Check effective (merged) state so we catch disables from either file.
      const effective = loadConfig(ctx.cwd);
      if (effective.disable?.includes(name)) {
        const globalCfg = readConfigFile(globalPath);
        const projectPath = join(ctx.cwd, CONFIG_DIR_NAME, "pi-bites.json");
        const projectCfg = readConfigFile(projectPath);
        const inGlobal = globalCfg.disable?.includes(name);
        const inProject = projectCfg.disable?.includes(name);
        const scope = inGlobal && inProject ? "global + project" : inGlobal ? "global" : "project";
        ctx.ui.notify(`"${name}" is already disabled (${scope}).`, "warning");
        return;
      }

      const targetPath = resolveWritePath(ctx.cwd);
      const config = readConfigFile(targetPath);
      config.disable = [...(config.disable ?? []), name];
      writeConfigFile(targetPath, config);

      const isProject = targetPath !== globalPath;
      ctx.ui.notify(
        `"${name}" disabled in ${isProject ? "project" : "global"} config.\nRestart pi to apply.`,
        "info",
      );
    },
  });

  // /bites:on ----------------------------------------------------------------
  pi.registerCommand("bites:on", {
    description: "Re-enable a disabled extension by name (takes effect on next launch)",
    getArgumentCompletions: completions,
    handler: async (args, ctx) => {
      const name = args.trim();
      if (!validateName(name, ctx)) return;

      const effective = loadConfig(ctx.cwd);
      if (!effective.disable?.includes(name)) {
        ctx.ui.notify(`"${name}" is already enabled.`, "warning");
        return;
      }

      // Since disable arrays are unioned, remove from BOTH files to truly enable.
      const projectPath = join(ctx.cwd, CONFIG_DIR_NAME, "pi-bites.json");
      for (const filePath of [globalPath, projectPath]) {
        const config = readConfigFile(filePath);
        if (config.disable?.includes(name)) {
          config.disable = config.disable.filter((n) => n !== name);
          if (config.disable.length === 0) delete config.disable;
          writeConfigFile(filePath, config);
        }
      }

      ctx.ui.notify(`"${name}" enabled.\nRestart pi to apply.`, "info");
    },
  });

  // /bites:list --------------------------------------------------------------
  pi.registerCommand("bites:list", {
    description: "List all extensions with their enabled/disabled status and config scope",
    handler: async (_args, ctx) => {
      const projectPath = join(ctx.cwd, CONFIG_DIR_NAME, "pi-bites.json");
      const globalCfg = readConfigFile(globalPath);
      const projectCfg = readConfigFile(projectPath);
      const globalDisabled = new Set(globalCfg.disable ?? []);
      const projectDisabled = new Set(projectCfg.disable ?? []);

      const lines = EXTENSION_NAMES.map((name) => {
        const inGlobal = globalDisabled.has(name);
        const inProject = projectDisabled.has(name);
        const disabled = inGlobal || inProject;

        const status = disabled ? "✗" : "✓";
        let scope = "";
        if (inGlobal && inProject) scope = "  (global + project)";
        else if (inGlobal) scope = "  (global)";
        else if (inProject) scope = "  (project)";

        return `  ${status}  ${name}${scope}`;
      });

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
