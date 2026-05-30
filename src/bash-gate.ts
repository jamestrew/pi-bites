/**
 * Bash Gate Extension
 *
 * Prompts for confirmation before running bash commands that match protected
 * patterns. Presents three choices:
 *   - Allow            → run this command once
 *   - Allow for session → run all future commands matching the same pattern automatically
 *   - Deny             → block this command and tell the model why
 *
 * Built-in patterns guard common destructive commands. Additional project
 * patterns can be added via pi-bites.json:
 *
 * ```json
 * {
 *   "bashGate": {
 *     "patterns": ["\\bbun\\s+check\\b", "\\bpytest\\b"]
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
import { extractBashFacts, type BashFacts } from "./bash-command-facts.js";
import type { SnacksConfig } from "./config.js";

const DIRECT_COMMANDS = new Set([
  "rm",
  "rmdir",
  "mv",
  "cp",
  "mkdir",
  "touch",
  "chmod",
  "chown",
  "chgrp",
  "ln",
  "tee",
  "truncate",
  "dd",
  "shred",
  "sudo",
  "su",
  "kill",
  "pkill",
  "killall",
  "reboot",
  "shutdown",
  "vi",
  "vim",
  "nano",
  "emacs",
  "code",
  "subl",
]);

const SUBCOMMAND_RULES = new Map<string, ReadonlySet<string>>([
  ["npm", new Set(["install", "uninstall", "update", "ci", "link", "publish"])],
  ["yarn", new Set(["add", "remove", "install", "publish"])],
  ["bun", new Set(["add", "remove", "install", "publish"])],
  ["pnpm", new Set(["add", "remove", "install", "publish"])],
  ["pip", new Set(["install", "uninstall"])],
  ["apt", new Set(["install", "remove", "purge", "update", "upgrade"])],
  ["apt-get", new Set(["install", "remove", "purge", "update", "upgrade"])],
  ["brew", new Set(["install", "uninstall", "upgrade"])],
  [
    "git",
    new Set([
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
    ]),
  ],
  ["systemctl", new Set(["start", "stop", "restart", "enable", "disable"])],
]);

export const DESTRUCTIVE_MATCH_LABELS = [
  ...DIRECT_COMMANDS,
  "redirect:>",
  "redirect:>>",
  "npm install",
  "npm uninstall",
  "npm update",
  "npm ci",
  "npm link",
  "npm publish",
  "yarn add",
  "yarn remove",
  "yarn install",
  "yarn publish",
  "bun add",
  "bun remove",
  "bun install",
  "bun publish",
  "pnpm add",
  "pnpm remove",
  "pnpm install",
  "pnpm publish",
  "pip install",
  "pip uninstall",
  "apt install",
  "apt remove",
  "apt purge",
  "apt update",
  "apt upgrade",
  "apt-get install",
  "apt-get remove",
  "apt-get purge",
  "apt-get update",
  "apt-get upgrade",
  "brew install",
  "brew uninstall",
  "brew upgrade",
  "git add",
  "git commit",
  "git push",
  "git pull",
  "git merge",
  "git rebase",
  "git reset",
  "git checkout",
  "git branch -d",
  "git stash",
  "git cherry-pick",
  "git revert",
  "git tag",
  "git init",
  "git clone",
  "systemctl start",
  "systemctl stop",
  "systemctl restart",
  "systemctl enable",
  "systemctl disable",
  "service start",
  "service stop",
  "service restart",
] as const;

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
  pattern?: RegExp;
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

function resolveConfiguredPatterns(config: SnacksConfig): RegExp[] {
  return (config.bashGate?.patterns ?? []).map((p) => new RegExp(p));
}

function normalizeToken(value?: string): string | undefined {
  return value?.toLowerCase();
}

function isDangerousRedirect(operator: string, target?: string): boolean {
  if (!operator.includes(">")) return false;
  if (operator.includes("<&") || operator.includes(">&")) return false;
  return target?.trim() !== "/dev/null";
}

function findBuiltInMatch(facts: BashFacts): BashGateMatch | undefined {
  for (const redirect of facts.redirects) {
    if (!isDangerousRedirect(redirect.operator, redirect.target)) continue;
    if (redirect.operator.includes(">>")) {
      return { label: "redirect:>>", source: "builtin" };
    }
    return { label: "redirect:>", source: "builtin" };
  }

  for (const command of facts.commands) {
    const name = normalizeToken(command.name);
    const subcommand = normalizeToken(command.subcommand);
    const thirdArg = normalizeToken(command.argv[2]);
    if (!name) continue;

    if (DIRECT_COMMANDS.has(name)) {
      return { label: name, source: "builtin" };
    }

    const riskySubcommands = SUBCOMMAND_RULES.get(name);
    if (riskySubcommands && subcommand && riskySubcommands.has(subcommand)) {
      return { label: `${name} ${subcommand}`, source: "builtin" };
    }

    if (name === "git" && subcommand === "branch" && (thirdArg === "-d" || thirdArg === "-D")) {
      return { label: "git branch -d", source: "builtin" };
    }

    if (name === "service") {
      const action = normalizeToken(command.argv.at(-1));
      if (action === "start" || action === "stop" || action === "restart") {
        return { label: `service ${action}`, source: "builtin" };
      }
    }
  }

  return undefined;
}

export async function findMatchedPattern(
  command: string,
  patternsOrConfig: RegExp[] | SnacksConfig = {},
): Promise<BashGateMatch | undefined> {
  const facts = await extractBashFacts(command);
  const builtIn = findBuiltInMatch(facts);
  if (builtIn) return builtIn;

  const patterns = Array.isArray(patternsOrConfig)
    ? patternsOrConfig
    : resolveConfiguredPatterns(patternsOrConfig);
  const pattern = patterns.find((candidate) => candidate.test(command));
  if (!pattern) return undefined;

  return {
    label: pattern.source,
    source: "configured",
    pattern,
  };
}

export default function registerBashGate(pi: ExtensionAPI, configRef: { current: SnacksConfig }) {
  pi.registerFlag("yolo", {
    description: "Bypass all bash-gate confirmations (useful for non-interactive / scripted runs)",
    type: "boolean",
    default: false,
  });

  let patterns: RegExp[] = [];

  pi.on("session_start", (_event, _ctx) => {
    patterns = resolveConfiguredPatterns(configRef.current);
  });

  const sessionAllowed = new Set<string>();

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return undefined;

    const command = event.input.command as string;

    const matchedPattern = await findMatchedPattern(command, patterns);
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

    const choice = await ctx.ui.select(`🔒 Bash gate — command requires approval`, [
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
