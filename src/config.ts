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
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
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

export interface SnacksConfig {
  explore?: ExploreConfig;
  statusline?: StatuslineConfig;
  bashGate?: BashGateConfig;
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

  return {
    explore: { ...global.explore, ...project.explore },
    statusline: { ...global.statusline, ...project.statusline },
    bashGate: { ...global.bashGate, ...project.bashGate },
  };
}
