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
 *   "explore": {
 *     "defaultModel": "anthropic/claude-sonnet-4-5",
 *     "defaultTools": "read,ls,bash"
 *   },
 *   "statusline": {
 *     "command": "python get_usage_limits.py"
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
 *   "bashGate" | "rtk" | "footer" | "statusline" | "tokenCount" | "usageDashboard" | "tools" | "explore" | "fzf" | "todo" | "question" | "notifications" | "checkpoints" | "spotme" | "inlineReferences" | "slashSkillAutocomplete" | "promptNormalization" | "atMentionContext" | "sessionTracker" | "ponytail"
 *
 * Global and project-local `disable` arrays are **unioned** — disabling something globally
 * suppresses it in every project.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

export interface ExploreConfig {
  /** Model to use when the LLM doesn't specify one. Default: "github-copilot/claude-haiku-4.5" */
  defaultModel?: string;
  /** Comma-separated list of tools available to the subagent. Default: "read,ls,bash" */
  defaultTools?: string;
}

export interface StatuslineConfig {
  /**
   * Shell command to run after each agent turn.
   * Executed in ctx.cwd. Its trimmed stdout is shown verbatim in the statusline.
   * If omitted, the statusline is not activated.
   */
  command?: string;
}

export interface CheckpointsConfig {
  /** Set to false to disable checkpoint tracking and /rewind. Default: true. */
  enabled?: boolean;
}

export interface PonytailConfig {
  /** Default Ponytail mode for new sessions. Default: "full". */
  defaultMode?: "off" | "lite" | "full" | "ultra" | "review";
}

export interface SubagentsConfig {
  /** Per-agent overrides keyed by agent type, e.g. { "explore": { "model": "..." } }. */
  [agentType: string]: { model?: string } | undefined;
}

export interface NotificationsConfig {
  /**
   * Shell command to run when the agent loop ends.
   * Receives a JSON payload on stdin: { cwd, message }
   * Compatible with Claude Code's Notification hook contract.
   *
   * Omit (or leave undefined) to use the built-in default:
   *   notify-send on Linux, osascript on macOS.
   * Set to "" to disable notifications entirely.
   */
  command?: string;
}

export type OneOrMany<T> = T | T[];

export type BashGateRedirectRule = "any-write" | "append" | "truncate";

export interface BashGateRule {
  /** Command name to match, e.g. "git" or ["rm", "mv"]. */
  cmd?: OneOrMany<string>;
  /** Subcommand to match, e.g. "push" for `git push`. */
  subcommands?: OneOrMany<string>;
  /** Match when any listed flag is present on the matched command. */
  flagAny?: OneOrMany<string>;
  /** Match write redirects anywhere in the parsed command. */
  redirects?: BashGateRedirectRule;
  /** Optional explanation surfaced in the UI when this rule matches. */
  reason?: string;
}

export interface BashGateConfig {
  /**
   * Structured rules matched against parsed bash command facts.
   * Adds extra gated rules on top of the built-in destructive-command list.
   */
  rules?: BashGateRule[];
}

export const EXTENSION_NAMES = [
  "bashGate",
  "rtk",
  "footer",
  "statusline",
  "tokenCount",
  "usageDashboard",
  "tools",
  "explore",
  "fzf",
  "todo",
  "question",
  "notifications",
  "checkpoints",
  "spotme",
  "inlineReferences",
  "slashSkillAutocomplete",
  "promptNormalization",
  "atMentionContext",
  "sessionTracker",
  "ponytail",
  "subagents",
] as const;

export type ExtensionName = (typeof EXTENSION_NAMES)[number];

export interface BitesConfig {
  explore?: ExploreConfig;
  statusline?: StatuslineConfig;
  bashGate?: BashGateConfig;
  notifications?: NotificationsConfig;
  checkpoints?: CheckpointsConfig;
  ponytail?: PonytailConfig;
  subagents?: SubagentsConfig;
  /**
   * List of extension names to disable entirely.
   * Global and project-local arrays are unioned.
   * Example: ["tokenCount", "statusline"]
   */
  disable?: ExtensionName[];
}

function tryReadJson(filePath: string, label: string): BitesConfig {
  if (!existsSync(filePath)) return {};
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as BitesConfig;
  } catch (err) {
    console.error(`pi-bites: failed to parse ${label} config at ${filePath}: ${err}`);
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

  const disableUnion = [
    ...new Set([...(global.disable ?? []), ...(project.disable ?? [])]),
  ] as ExtensionName[];

  return {
    explore: { ...global.explore, ...project.explore },
    statusline: { ...global.statusline, ...project.statusline },
    bashGate: { ...global.bashGate, ...project.bashGate },
    notifications: { ...global.notifications, ...project.notifications },
    checkpoints: { ...global.checkpoints, ...project.checkpoints },
    ponytail: { ...global.ponytail, ...project.ponytail },
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
    if (!EXTENSION_NAMES.includes(name as ExtensionName)) {
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
      config.disable = [...(config.disable ?? []), name as ExtensionName];
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
        if (config.disable?.includes(name as ExtensionName)) {
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
