/**
 * Pi-snacks configuration loader.
 *
 * Config is read from two optional JSON files, merged with project-local taking precedence:
 *   ~/.pi/agent/pi-snacks.json   (global)
 *   <cwd>/.pi/pi-snacks.json     (project-local)
 *
 * Example pi-snacks.json:
 * ```json
 * {
 *   "explore": {
 *     "defaultModel": "anthropic/claude-sonnet-4-5",
 *     "defaultTools": "read,grep,find,ls"
 *   },
 *   "statusline": {
 *     "command": "python get_usage_limits.py"
 *   },
 *   "bashGate": {
 *     "patterns": [
 *       "\\bbun\\s+test\\b",
 *       "\\bnpm\\s+test\\b",
 *       "\\bpytest\\b"
 *     ]
 *   }
 * }
 * ```
 *
 * Each top-level section is optional — omitted sections fall back to built-in defaults.
 * For bashGate.patterns, providing an array *replaces* the built-in pattern list entirely.
 *
 * Use `disable` to turn off individual extensions by name. Valid names:
 *   "bashGate" | "statusline" | "tokenCount" | "tools" | "explore" | "todo" | "question"
 *
 * Global and project-local `disable` arrays are **unioned** — disabling something globally
 * suppresses it in every project.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getAgentDir } from "@mariozechner/pi-coding-agent";

export interface ExploreConfig {
  /** Model to use when the LLM doesn't specify one. Default: "github-copilot/claude-haiku-4.5" */
  defaultModel?: string;
  /** Comma-separated list of tools available to the subagent. Default: "read,grep,find,ls,bash" */
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

export interface BashGateConfig {
  /**
   * Array of regex pattern strings tested against the full bash command.
   * Replaces the built-in default pattern list entirely when provided.
   * Each string is passed to `new RegExp(pattern)`.
   */
  patterns?: string[];
}

/** Known extension names that can be disabled. */
export type ExtensionName =
  | "bashGate"
  | "statusline"
  | "tokenCount"
  | "tools"
  | "explore"
  | "todo"
  | "fzf"
  | "question";

export interface SnacksConfig {
  explore?: ExploreConfig;
  statusline?: StatuslineConfig;
  bashGate?: BashGateConfig;
  /**
   * List of extension names to disable entirely.
   * Global and project-local arrays are unioned.
   * Example: ["tokenCount", "statusline"]
   */
  disable?: ExtensionName[];
}

function tryReadJson(filePath: string, label: string): SnacksConfig {
  if (!existsSync(filePath)) return {};
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as SnacksConfig;
  } catch (err) {
    console.error(`pi-snacks: failed to parse ${label} config at ${filePath}: ${err}`);
    return {};
  }
}

/**
 * Load and merge config from global and project-local files.
 * Project-local values override global values within each section.
 */
export function loadConfig(cwd: string): SnacksConfig {
  const globalPath = join(getAgentDir(), "pi-snacks.json");
  const projectPath = join(cwd, ".pi", "pi-snacks.json");

  const global = tryReadJson(globalPath, "global");
  const project = tryReadJson(projectPath, "project-local");

  const disableUnion = [
    ...new Set([...(global.disable ?? []), ...(project.disable ?? [])]),
  ] as ExtensionName[];

  return {
    explore: { ...global.explore, ...project.explore },
    statusline: { ...global.statusline, ...project.statusline },
    bashGate: { ...global.bashGate, ...project.bashGate },
    ...(disableUnion.length > 0 ? { disable: disableUnion } : {}),
  };
}

// ---------------------------------------------------------------------------
// Config-file write helpers
// ---------------------------------------------------------------------------

/** All valid extension names, in display order. */
export const EXTENSION_NAMES: ExtensionName[] = [
  "bashGate",
  "statusline",
  "tokenCount",
  "tools",
  "explore",
  "fzf",
  "todo",
  "question",
];

/**
 * Resolve which config file to write to:
 * project-local (.pi/pi-snacks.json) if it already exists, otherwise global.
 */
function resolveWritePath(cwd: string): string {
  const projectPath = join(cwd, ".pi", "pi-snacks.json");
  if (existsSync(projectPath)) return projectPath;
  return join(getAgentDir(), "pi-snacks.json");
}

function readConfigFile(filePath: string): SnacksConfig {
  return tryReadJson(filePath, filePath);
}

function writeConfigFile(filePath: string, config: SnacksConfig): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

// ---------------------------------------------------------------------------
// /bites:on, /bites:off, /bites:list commands
// ---------------------------------------------------------------------------

export function registerBitesCommands(pi: ExtensionAPI): void {
  const globalPath = join(getAgentDir(), "pi-snacks.json");

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
        const projectPath = join(ctx.cwd, ".pi", "pi-snacks.json");
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
      const projectPath = join(ctx.cwd, ".pi", "pi-snacks.json");
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
      const projectPath = join(ctx.cwd, ".pi", "pi-snacks.json");
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
