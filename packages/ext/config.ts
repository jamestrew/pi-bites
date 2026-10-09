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
 *   "$schema": "https://raw.githubusercontent.com/jamestrew/pi-bites/master/pi-bites.schema.json",
 *   "smallModel": {
 *     "model": "github-copilot/claude-haiku-4.5",
 *     "thinking": "low"
 *   },
 *   "statusline": {
 *     "command": "python get_usage_limits.py"
 *   },
 *   "autoCompaction": {
 *     "thresholdTokens": 200000
 *   },
 *   "bashGate": {
 *     "mode": "yolo",
 *     "rules": [
 *       { "cmd": "bun", "subcommands": ["test"] },
 *       { "cmd": "npm", "subcommands": ["test"] },
 *       { "cmd": "pytest" }
 *     ]
 *   }
 * }
 * ```
 *
 * Each top-level section is optional — omitted sections fall back to built-in defaults.
 * For bashGate.rules, providing an array adds extra gated rules on top of the
 * built-in destructive-command protections.
 *
 * Use `disable` to turn off individual extensions by name. Valid names:
 *   "bashGate" | "autoMode" | "footer" | "statusline" | "tokenCount" | "usageDashboard" | "context" | "tools" | "fzf" | "notifications" | "autoCompaction" | "spotme" | "skillPromptReferences" | "promptNormalization" | "atMentionContext" | "sessionTracker" | "ponytail" | "subagents" | "view" | "codexAdapter"
 *
 * Global and project-local `disable` arrays are **unioned** — disabling something globally
 * suppresses it in every project.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { ThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

export type OneOrMany<T> = T | T[];
export const BASH_GATE_MODES = ["manual", "auto", "yolo"] as const;
export type BashGateMode = (typeof BASH_GATE_MODES)[number];
export const BASH_GATE_REDIRECT_RULES = ["any-write", "append", "truncate"] as const;
export type BashGateRedirectRule = (typeof BASH_GATE_REDIRECT_RULES)[number];

export const EXTENSION_NAMES = [
  "bashGate",
  "footer",
  "statusline",
  "tokenCount",
  "usageDashboard",
  "context",
  "tools",
  "fzf",
  "notifications",
  "autoCompaction",
  "autoMode",
  "spotme",
  "skillPromptReferences",
  "promptNormalization",
  "atMentionContext",
  "sessionTracker",
  "ponytail",
  "subagents",
  "view",
  "codexAdapter",
] as const;

export type ExtensionName = (typeof EXTENSION_NAMES)[number];

const EXTENSION_DESCRIPTIONS: Partial<Record<ExtensionName, string>> = {
  skillPromptReferences: "$skill:name / $prompt:name completion and context loading",
  atMentionContext: "@path file contents / directory listings",
};

const THINKING_LEVELS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly ThinkingLevel[];
const StringOrListSchema = Type.Union([Type.String(), Type.Array(Type.String())]);

const SmallModelSchema = Type.Object({
  model: Type.Optional(
    Type.String({
      description: "Cheap model for lightweight internal tasks, as provider/model-id.",
      default: "github-copilot/gpt-6-luna",
    }),
  ),
  thinking: Type.Optional(
    Type.Enum(THINKING_LEVELS, {
      description: "Thinking level for lightweight internal tasks.",
      default: "low",
    }),
  ),
});
export type SmallModelConfig = Static<typeof SmallModelSchema>;

const StatuslineSchema = Type.Object({
  command: Type.Optional(
    Type.String({
      description: "Shell command whose trimmed stdout is shown in the statusline.",
    }),
  ),
});
export type StatuslineConfig = Static<typeof StatuslineSchema>;

const BashGateRuleSchema = Type.Object({
  cmd: Type.Optional(StringOrListSchema),
  subcommands: Type.Optional(StringOrListSchema),
  flagAny: Type.Optional(StringOrListSchema),
  redirects: Type.Optional(Type.Enum(BASH_GATE_REDIRECT_RULES)),
  reason: Type.Optional(Type.String()),
});
export type BashGateRule = Static<typeof BashGateRuleSchema>;

const BashGateSchema = Type.Object({
  mode: Type.Optional(
    Type.Enum(BASH_GATE_MODES, {
      description: "Initial permission mode for each session.",
      default: "manual",
    }),
  ),
  rules: Type.Optional(
    Type.Array(BashGateRuleSchema, {
      description: "Extra gated rules added to the built-in destructive-command protections.",
    }),
  ),
});
export type BashGateConfig = Static<typeof BashGateSchema>;

const NotificationsSchema = Type.Object({
  command: Type.Optional(
    Type.String({
      description:
        "Shell command for notifications; receives { cwd, message } JSON on stdin. An empty string disables notifications.",
    }),
  ),
});
export type NotificationsConfig = Static<typeof NotificationsSchema>;

const AutoCompactionSchema = Type.Object({
  thresholdTokens: Type.Optional(
    Type.Integer({
      minimum: 1,
      default: 200000,
      description: "Token cap; compacts sooner at 85% of the active model's context window.",
    }),
  ),
});
export type AutoCompactionConfig = Static<typeof AutoCompactionSchema>;

const AutoModeSchema = Type.Object({
  model: Type.Optional(
    Type.String({
      description: "Reviewer model as provider/model-id. Defaults to the active model.",
    }),
  ),
  thinking: Type.Optional(
    Type.Enum(THINKING_LEVELS, {
      description: "Reviewer thinking level.",
      default: "low",
    }),
  ),
  policy: Type.Optional(
    Type.String({
      description: "Reviewer policy text. Defaults to the bundled safety policy.",
    }),
  ),
});
export type AutoModeConfig = Static<typeof AutoModeSchema>;

const CodexAdapterSchema = Type.Object({
  webSearchProviders: Type.Optional(
    Type.Array(Type.String({ pattern: "\\S" }), {
      description: "Responses provider IDs explicitly trusted to implement Codex /alpha/search.",
    }),
  ),
  allowOpenAICodexFallback: Type.Optional(
    Type.Boolean({
      default: false,
      description:
        "Permit web_run to use stock openai-codex auth when the active provider cannot search.",
    }),
  ),
});
export type CodexAdapterConfig = Static<typeof CodexAdapterSchema>;

// Runtime accepts unknown keys to preserve existing configs during reads and writes.
// The generator closes all objects in the editor schema to flag stale settings.
export const BitesConfigSchema = Type.Object(
  {
    $schema: Type.Optional(
      Type.String({
        description: "Editor JSON Schema location. Does not affect runtime settings.",
      }),
    ),
    smallModel: Type.Optional(SmallModelSchema),
    statusline: Type.Optional(StatuslineSchema),
    bashGate: Type.Optional(BashGateSchema),
    notifications: Type.Optional(NotificationsSchema),
    autoCompaction: Type.Optional(AutoCompactionSchema),
    autoMode: Type.Optional(AutoModeSchema),
    codexAdapter: Type.Optional(CodexAdapterSchema),
    disable: Type.Optional(
      Type.Array(Type.Enum(EXTENSION_NAMES), {
        description:
          "Extensions disabled globally or for this project. Global and project lists are unioned. Use current names; retired aliases are flagged by this schema.",
      }),
    ),
  },
  {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "Pi-bites configuration",
    description:
      "Global ~/.pi/agent/pi-bites.json or project-local .pi/pi-bites.json. Project values override global values within each section; disable lists are unioned. All settings are optional.",
    $comment:
      "Generated from packages/ext/config.ts by bun run schema:generate. Do not edit directly.",
  },
);
export type BitesConfig = Static<typeof BitesConfigSchema>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseBitesConfig(value: unknown): BitesConfig | undefined {
  // Drop the retired explore toggle; preserve renamed disables without duplicate names.
  if (isRecord(value) && Array.isArray(value.disable)) {
    value = {
      ...value,
      disable: [
        ...new Set(
          value.disable
            .filter((name: unknown) => name !== "explore")
            .map((name: unknown) =>
              name === "inlineReferences" || name === "slashSkillAutocomplete"
                ? "skillPromptReferences"
                : name,
            ),
        ),
      ],
    };
  }
  return Value.Check(BitesConfigSchema, value) ? value : undefined;
}

function readConfigFile(filePath: string): BitesConfig {
  try {
    const config = parseBitesConfig(JSON.parse(readFileSync(filePath, "utf-8")));
    if (!config) throw new Error("config does not match the pi-bites schema");
    return config;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read config at ${filePath}: ${message}`);
  }
}

function tryReadJson(filePath: string, label: string): BitesConfig {
  try {
    return readConfigFile(filePath);
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
    codexAdapter: { ...global.codexAdapter, ...project.codexAdapter },
    ...(disableUnion.length > 0 ? { disable: disableUnion } : {}),
  };
}

// ---------------------------------------------------------------------------
// Scope-aware config mutation
// ---------------------------------------------------------------------------

function writeConfigFile(filePath: string, config: BitesConfig): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

function setExtensionDisabled(cwd: string, name: ExtensionName, disabled: boolean) {
  const globalPath = join(getAgentDir(), "pi-bites.json");
  const projectPath = join(cwd, CONFIG_DIR_NAME, "pi-bites.json");
  // Validate both scopes before any write. Later write failures are not rolled back.
  const files = [
    { path: globalPath, scope: "global", config: readConfigFile(globalPath) },
    { path: projectPath, scope: "project", config: readConfigFile(projectPath) },
  ] as const;
  const disablingFiles = files.filter((file) => file.config.disable?.includes(name));
  const scope = disablingFiles.map((file) => file.scope).join(" + ");
  const alreadyDisabled = disablingFiles.length > 0;
  if (disabled === alreadyDisabled) return { changed: false, scope };

  if (disabled) {
    const target = existsSync(projectPath) ? files[1] : files[0];
    target.config.disable = [...(target.config.disable ?? []), name];
    writeConfigFile(target.path, target.config);
    return { changed: true, scope: target.scope };
  }

  // Disable arrays are unioned, so enabling must remove the name from both scopes.
  for (const file of disablingFiles) {
    file.config.disable = (file.config.disable ?? []).filter((n) => n !== name);
    if (file.config.disable.length === 0) delete file.config.disable;
    writeConfigFile(file.path, file.config);
  }
  return { changed: true, scope };
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

  for (const disabled of [true, false]) {
    pi.registerCommand(disabled ? "bites:off" : "bites:on", {
      description: disabled
        ? "Disable an extension by name (takes effect on next launch)"
        : "Re-enable a disabled extension by name (takes effect on next launch)",
      getArgumentCompletions: completions,
      handler: async (args, ctx) => {
        const name = args.trim();
        if (!validateName(name, ctx)) return;

        try {
          const result = setExtensionDisabled(ctx.cwd, name, disabled);
          if (!result.changed) {
            ctx.ui.notify(
              disabled
                ? `"${name}" is already disabled (${result.scope}).`
                : `"${name}" is already enabled.`,
              "warning",
            );
            return;
          }
          ctx.ui.notify(
            disabled
              ? `"${name}" disabled in ${result.scope} config.\nRestart pi to apply.`
              : `"${name}" enabled.\nRestart pi to apply.`,
            "info",
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          ctx.ui.notify(`Failed to update config: ${message}`, "error");
        }
      },
    });
  }

  // /bites:list --------------------------------------------------------------
  pi.registerCommand("bites:list", {
    description: "List all extensions with their enabled/disabled status and config scope",
    handler: async (_args, ctx) => {
      const projectPath = join(ctx.cwd, CONFIG_DIR_NAME, "pi-bites.json");
      const globalCfg = tryReadJson(globalPath, "global");
      const projectCfg = tryReadJson(projectPath, "project-local");
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

        const description = EXTENSION_DESCRIPTIONS[name];
        return `  ${status}  ${name}${scope}${description ? ` — ${description}` : ""}`;
      });

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
