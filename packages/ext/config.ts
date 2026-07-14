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
import { Type, type Static } from "typebox";
import * as Value from "typebox/value";

const StringList = Type.Union([Type.String(), Type.Array(Type.String())]);
const ThinkingLevelSchema = Type.Union([
  Type.Literal("minimal"),
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("xhigh"),
  Type.Literal("max"),
]);
const BashGateRuleSchema = Type.Object({
  cmd: Type.Optional(StringList),
  subcommands: Type.Optional(StringList),
  flagAny: Type.Optional(StringList),
  redirects: Type.Optional(
    Type.Union([Type.Literal("any-write"), Type.Literal("append"), Type.Literal("truncate")]),
  ),
  reason: Type.Optional(Type.String()),
});

export type SmallModelConfig = Static<typeof SmallModelConfigSchema>;
export type StatuslineConfig = Static<typeof StatuslineConfigSchema>;
export type CheckpointsConfig = Static<typeof CheckpointsConfigSchema>;
export type PonytailConfig = Static<typeof PonytailConfigSchema>;
export type SubagentsConfig = Static<typeof SubagentsConfigSchema>;
export type NotificationsConfig = Static<typeof NotificationsConfigSchema>;
export type OneOrMany<T> = T | T[];
export type BashGateRedirectRule = Static<typeof BashGateRuleSchema>["redirects"] & string;
export type BashGateRule = Static<typeof BashGateRuleSchema>;
export type BashGateConfig = Static<typeof BashGateConfigSchema>;

const SmallModelConfigSchema = Type.Object({
  model: Type.Optional(Type.String()),
  thinking: Type.Optional(ThinkingLevelSchema),
});
const StatuslineConfigSchema = Type.Object({ command: Type.Optional(Type.String()) });
const CheckpointsConfigSchema = Type.Object({ enabled: Type.Optional(Type.Boolean()) });
const PonytailConfigSchema = Type.Object({
  defaultMode: Type.Optional(
    Type.Union([
      Type.Literal("off"),
      Type.Literal("lite"),
      Type.Literal("full"),
      Type.Literal("ultra"),
      Type.Literal("review"),
    ]),
  ),
});
const SubagentsConfigSchema = Type.Record(
  Type.String(),
  Type.Object({ model: Type.Optional(Type.String()) }),
);
const NotificationsConfigSchema = Type.Object({ command: Type.Optional(Type.String()) });
const BashGateConfigSchema = Type.Object({ rules: Type.Optional(Type.Array(BashGateRuleSchema)) });

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

export const BitesConfigSchema = Type.Object({
  smallModel: Type.Optional(SmallModelConfigSchema),
  statusline: Type.Optional(StatuslineConfigSchema),
  bashGate: Type.Optional(BashGateConfigSchema),
  notifications: Type.Optional(NotificationsConfigSchema),
  checkpoints: Type.Optional(CheckpointsConfigSchema),
  ponytail: Type.Optional(PonytailConfigSchema),
  subagents: Type.Optional(SubagentsConfigSchema),
  disable: Type.Optional(
    Type.Array(
      Type.Union([
        Type.Literal("bashGate"),
        Type.Literal("rtk"),
        Type.Literal("footer"),
        Type.Literal("statusline"),
        Type.Literal("tokenCount"),
        Type.Literal("usageDashboard"),
        Type.Literal("tools"),
        Type.Literal("explore"),
        Type.Literal("fzf"),
        Type.Literal("todo"),
        Type.Literal("question"),
        Type.Literal("notifications"),
        Type.Literal("checkpoints"),
        Type.Literal("spotme"),
        Type.Literal("inlineReferences"),
        Type.Literal("slashSkillAutocomplete"),
        Type.Literal("promptNormalization"),
        Type.Literal("atMentionContext"),
        Type.Literal("sessionTracker"),
        Type.Literal("ponytail"),
        Type.Literal("subagents"),
      ]),
    ),
  ),
});

export type BitesConfig = Static<typeof BitesConfigSchema>;

export function parseBitesConfig(value: unknown): BitesConfig | undefined {
  return Value.Check(BitesConfigSchema, value) ? value : undefined;
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
  defaultMode: NonNullable<PonytailConfig["defaultMode"]>,
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
