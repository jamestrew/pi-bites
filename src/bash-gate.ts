/**
 * Bash Gate Extension
 *
 * Prompts for confirmation before running bash commands that match protected
 * structured rules. Presents three choices:
 *   - Allow             → run this command once
 *   - Allow for session → run all future commands matching the same rule automatically
 *   - Deny              → block this command and tell the model why
 *
 * Built-in rules guard common destructive commands. Additional project rules
 * can be added via pi-bites.json:
 *
 * ```json
 * {
 *   "bashGate": {
 *     "rules": [
 *       { "cmd": "bun", "subcommands": ["test"] },
 *       { "redirects": "any-write" }
 *     ]
 *   }
 * }
 * ```
 *
 * Pass `--yolo` on the CLI to bypass all gates entirely — useful for
 * non-interactive / scripted runs where no UI is available:
 *
 * ```bash
 * pi --yolo -p "run the tests"
 * ```
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { extractBashFacts, type BashFacts, type BashSimpleCommand } from "./bash-command-facts.js";
import type {
  BashGateConfig,
  BashGateRedirectRule,
  BashGateRule,
  OneOrMany,
  SnacksConfig,
} from "./config.js";

export const DEFAULT_BASH_GATE_RULES: BashGateRule[] = [
  { cmd: ["rm", "rmdir", "mv", "cp", "mkdir", "touch"] },
  { cmd: ["chmod", "chown", "chgrp", "ln", "tee", "truncate", "dd", "shred"] },
  { cmd: ["sudo", "su", "kill", "pkill", "killall", "reboot", "shutdown"] },
  {
    cmd: "git",
    subcommands: [
      "add",
      "commit",
      "push",
      "pull",
      "merge",
      "rebase",
      "reset",
      "checkout",
      "stash",
      "cherry-pick",
      "revert",
      "tag",
      "init",
      "clone",
    ],
  },
  { cmd: "git", subcommands: "branch", flagAny: ["-d", "-D"] },
  { cmd: "npm", subcommands: ["install", "uninstall", "update", "ci", "link", "publish"] },
  { cmd: "yarn", subcommands: ["add", "remove", "install", "publish"] },
  { cmd: "bun", subcommands: ["add", "remove", "install", "publish"] },
  { cmd: "pnpm", subcommands: ["add", "remove", "install", "publish"] },
  { cmd: "pip", subcommands: ["install", "uninstall"] },
  { cmd: ["apt", "apt-get"], subcommands: ["install", "remove", "purge", "update", "upgrade"] },
  { cmd: "brew", subcommands: ["install", "uninstall", "upgrade"] },
  { cmd: "systemctl", subcommands: ["start", "stop", "restart", "enable", "disable"] },
  { cmd: "service", subcommands: ["start", "stop", "restart"] },
  { cmd: ["vim", "vi", "nano", "emacs", "code", "subl"] },
  { redirects: "any-write" },
];

export const SAFE_PATTERNS = [
  /^\s*cat\b/,
  /^\s*head\b/,
  /^\s*tail\b/,
  /^\s*less\b/,
  /^\s*more\b/,
  /^\s*grep\b/,
  /^\s*find\b/,
  /^\s*ls\b/,
  /^\s*pwd\b/,
  /^\s*echo\b/,
  /^\s*printf\b/,
  /^\s*wc\b/,
  /^\s*sort\b/,
  /^\s*uniq\b/,
  /^\s*diff\b/,
  /^\s*file\b/,
  /^\s*stat\b/,
  /^\s*du\b/,
  /^\s*df\b/,
  /^\s*tree\b/,
  /^\s*which\b/,
  /^\s*whereis\b/,
  /^\s*type\b/,
  /^\s*env\b/,
  /^\s*printenv\b/,
  /^\s*uname\b/,
  /^\s*whoami\b/,
  /^\s*id\b/,
  /^\s*date\b/,
  /^\s*cal\b/,
  /^\s*uptime\b/,
  /^\s*ps\b/,
  /^\s*top\b/,
  /^\s*htop\b/,
  /^\s*free\b/,
  /^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get)/i,
  /^\s*git\s+ls-/i,
  /^\s*npm\s+(list|ls|view|info|search|outdated|audit)/i,
  /^\s*yarn\s+(list|info|why|audit)/i,
  /^\s*node\s+--version/i,
  /^\s*python\s+--version/i,
  /^\s*curl\s/i,
  /^\s*wget\s+-O\s*-/i,
  /^\s*jq\b/,
  /^\s*sed\s+-n/i,
  /^\s*awk\b/,
  /^\s*rg\b/,
  /^\s*fd\b/,
  /^\s*bat\b/,
  /^\s*eza\b/,
];

export interface BashGateMatch {
  label: string;
  source: "builtin" | "configured";
  rule: BashGateRule;
  reason?: string;
}

interface BashRuleCommandMatch {
  label: string;
}

/**
 * When a command is approved, add the time spent waiting in the gate to the
 * timeout (if one was set by the model). This is necessary because the TUI
 * elapsed timer starts at `tool_execution_start` — which fires *before* our
 * gate handler runs — so the timer is already counting while the user reads
 * the prompt. The actual process `setTimeout` inside `ops.exec()` only starts
 * after `spawn()`, which is after this handler returns, so the spawned process
 * always gets its full intended timeout. By compensating `event.input.timeout`
 * here we keep the displayed elapsed time consistent with the timeout value.
 */
function compensateTimeout(input: Record<string, unknown>, gateStartMs: number): void {
  if (typeof input.timeout !== "number") return;
  const gateWaitSec = (Date.now() - gateStartMs) / 1000;
  input.timeout = input.timeout + gateWaitSec;
}

function normalizeToken(value?: string): string | undefined {
  return value?.toLowerCase();
}

function asArray<T>(value?: OneOrMany<T>): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function resolveConfiguredRules(config: SnacksConfig): BashGateRule[] {
  return config.bashGate?.rules ?? [];
}

function resolveEffectiveRules(config: BashGateConfig | SnacksConfig = {}): BashGateRule[] {
  const configuredRules =
    "bashGate" in config
      ? resolveConfiguredRules(config)
      : ((config as BashGateConfig).rules ?? []);
  return [...DEFAULT_BASH_GATE_RULES, ...configuredRules];
}

function isDangerousRedirect(operator: string, target?: string): boolean {
  if (!operator.includes(">")) return false;
  if (operator.includes("<&") || operator.includes(">&")) return false;
  return target?.trim() !== "/dev/null";
}

function matchesRedirectRule(facts: BashFacts, redirectRule: BashGateRedirectRule): boolean {
  return facts.redirects.some((redirect) => {
    if (!isDangerousRedirect(redirect.operator, redirect.target)) return false;
    if (redirectRule === "any-write") return true;
    if (redirectRule === "append") return redirect.operator.includes(">>");
    return redirect.operator.includes(">") && !redirect.operator.includes(">>");
  });
}

function matchCommandRule(
  command: BashSimpleCommand,
  rule: BashGateRule,
): BashRuleCommandMatch | undefined {
  const name = normalizeToken(command.name);
  const subcommand = normalizeToken(command.subcommand);
  const cmdOptions = asArray(rule.cmd).map(normalizeToken).filter(Boolean);
  const subcommandOptions = asArray(rule.subcommands).map(normalizeToken).filter(Boolean);
  const flagOptions = asArray(rule.flagAny).map(normalizeToken).filter(Boolean);
  const commandFlags = command.flags.map((flag) => normalizeToken(flag)).filter(Boolean);

  if (cmdOptions.length > 0 && (!name || !cmdOptions.includes(name))) return undefined;

  let matchedSubcommand: string | undefined;
  if (subcommandOptions.length > 0) {
    if (name === "service") {
      const serviceAction = normalizeToken(command.argv.at(-1));
      if (!serviceAction || !subcommandOptions.includes(serviceAction)) return undefined;
      matchedSubcommand = serviceAction;
    } else {
      if (!subcommand || !subcommandOptions.includes(subcommand)) return undefined;
      matchedSubcommand = subcommand;
    }
  }

  const matchedFlag =
    flagOptions.length > 0 ? commandFlags.find((flag) => flagOptions.includes(flag)) : undefined;
  if (flagOptions.length > 0 && !matchedFlag) return undefined;

  if (name === "git" && matchedSubcommand === "branch" && matchedFlag) {
    return { label: `git branch -d` };
  }

  if (matchedSubcommand) return { label: `${name} ${matchedSubcommand}` };
  if (matchedFlag && name) return { label: `${name} ${matchedFlag}` };
  if (name) return { label: name };
  return undefined;
}

function matchRuleAgainstFacts(facts: BashFacts, rule: BashGateRule): string | undefined {
  if (rule.redirects && !matchesRedirectRule(facts, rule.redirects)) return undefined;

  const hasCommandConstraint =
    rule.cmd !== undefined || rule.subcommands !== undefined || rule.flagAny !== undefined;
  if (!hasCommandConstraint) {
    if (!rule.redirects) return undefined;
    const hasAppend = matchesRedirectRule(facts, "append");
    if (rule.redirects === "append") return "redirect:>>";
    if (rule.redirects === "truncate") return "redirect:>";
    return hasAppend ? "redirect:>>" : "redirect:>";
  }

  for (const command of facts.commands) {
    const matched = matchCommandRule(command, rule);
    if (matched) return matched.label;
  }

  return undefined;
}

export async function findMatchedPattern(
  command: string,
  rulesOrConfig: BashGateRule[] | BashGateConfig | SnacksConfig = {},
): Promise<BashGateMatch | undefined> {
  const facts = await extractBashFacts(command);

  const configuredRules = Array.isArray(rulesOrConfig)
    ? rulesOrConfig
    : "bashGate" in rulesOrConfig
      ? resolveConfiguredRules(rulesOrConfig)
      : ((rulesOrConfig as BashGateConfig).rules ?? []);

  for (const rule of configuredRules) {
    const label = matchRuleAgainstFacts(facts, rule);
    if (!label) continue;
    return {
      label,
      source: "configured",
      rule,
      reason: rule.reason,
    };
  }

  for (const rule of DEFAULT_BASH_GATE_RULES) {
    const label = matchRuleAgainstFacts(facts, rule);
    if (!label) continue;
    return {
      label,
      source: "builtin",
      rule,
      reason: rule.reason,
    };
  }

  return undefined;
}

export default function registerBashGate(pi: ExtensionAPI, configRef: { current: SnacksConfig }) {
  pi.registerFlag("yolo", {
    description: "Bypass all bash-gate confirmations (useful for non-interactive / scripted runs)",
    type: "boolean",
    default: false,
  });

  let rules: BashGateRule[] = [];

  pi.on("session_start", (_event, _ctx) => {
    rules = resolveEffectiveRules(configRef.current);
  });

  const sessionAllowed = new Set<string>();

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return undefined;

    const command = event.input.command as string;

    const matchedPattern = await findMatchedPattern(command, rules);
    if (!matchedPattern) return undefined;

    // --yolo flag: skip all gates.
    if (pi.getFlag("yolo")) return undefined;

    // Pattern was already approved for this session — run silently.
    if (sessionAllowed.has(matchedPattern.label)) return undefined;

    if (!ctx.hasUI) {
      // Non-interactive mode (e.g. `pi -p`) — block by default.
      const reason =
        process.env.PI_BITES_SUBAGENT === "explore"
          ? "Bash gate: destructive command not allowed during exploration."
          : "Bash gate: no UI available for confirmation.";
      return { block: true, reason };
    }

    // Snapshot the time before showing the prompt. The TUI's elapsed timer
    // starts at `tool_execution_start` (before this handler runs), so any time
    // the user spends in the gate is already ticking. We compensate by adding
    // the gate wait duration to `event.input.timeout` so the spawned process
    // still gets its full intended timeout.
    const gateStartMs = Date.now();

    pi.events.emit("bites:bash_gate", { cwd: ctx.cwd, command });

    const prompt = matchedPattern.reason
      ? `🔒 Bash gate — ${matchedPattern.reason}`
      : `🔒 Bash gate — command requires approval (${matchedPattern.label})`;
    const choice = await ctx.ui.select(prompt, [
      "Allow",
      `Allow for session ("${matchedPattern.label}")`,
      "Deny",
    ]);

    if (choice?.startsWith("Allow for session")) {
      sessionAllowed.add(matchedPattern.label);
      compensateTimeout(event.input, gateStartMs);
      return undefined; // proceed
    }

    if (choice === "Allow") {
      compensateTimeout(event.input, gateStartMs);
      return undefined; // proceed just this once
    }

    return { block: true, reason: "Bash gate: command was denied by the user." };
  });
}
