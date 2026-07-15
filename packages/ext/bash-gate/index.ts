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
 * Press Ctrl+Shift+Y to toggle the gate for the main agent. Pass `--yolo` on
 * the CLI to bypass all gates entirely — useful for non-interactive / scripted
 * runs where no UI is available:
 *
 * ```bash
 * pi --yolo -p "run the tests"
 * ```
 */

import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { extractBashFacts, type BashFacts, type BashSimpleCommand } from "./bash-command-facts.js";
import type {
  BashGateConfig,
  BashGateRedirectRule,
  BashGateRule,
  OneOrMany,
  BitesConfig,
} from "../config.js";
import {
  SUBAGENT_METADATA_ENTRY,
  parseSubagentMetadata,
  type SubagentMetadata,
} from "../subagents/agent-runner.js";
import { requestSubagentApproval } from "./events.js";

export type { ApprovalRequest } from "./events.js";
type BashGatePolicy = "deny" | "prompt";

function subagentMetadata(entries: SessionEntry[]): SubagentMetadata | null | undefined {
  const entry = [...entries]
    .reverse()
    .find(
      (candidate) =>
        candidate.type === "custom" && candidate.customType === SUBAGENT_METADATA_ENTRY,
    );
  if (entry?.type !== "custom") return undefined;
  return parseSubagentMetadata(entry.data) ?? null;
}

export function subagentBashGatePolicy(entries: SessionEntry[]): BashGatePolicy | undefined {
  const metadata = subagentMetadata(entries);
  if (metadata === undefined) return undefined;
  if (metadata === null) return "deny";
  const policy = metadata.bashGatePolicy;
  return policy === "deny" || policy === "prompt" ? policy : "deny";
}

export const DEFAULT_BASH_GATE_RULES: BashGateRule[] = [
  { cmd: ["rm", "rmdir"] },
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

function resolveConfiguredRules(config: BitesConfig): BashGateRule[] {
  return config.bashGate?.rules ?? [];
}

function resolveEffectiveRules(config: BashGateConfig | BitesConfig = {}): BashGateRule[] {
  const configuredRules =
    "rules" in config
      ? (config.rules ?? [])
      : "bashGate" in config
        ? resolveConfiguredRules(config)
        : [];
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

function matchRuleAgainstFacts(facts: BashFacts, rule: BashGateRule): string[] {
  if (rule.redirects && !matchesRedirectRule(facts, rule.redirects)) return [];

  const hasCommandConstraint =
    rule.cmd !== undefined || rule.subcommands !== undefined || rule.flagAny !== undefined;
  if (!hasCommandConstraint) {
    if (!rule.redirects) return [];
    const hasAppend = matchesRedirectRule(facts, "append");
    if (rule.redirects === "append") return ["redirect:>>"];
    if (rule.redirects === "truncate") return ["redirect:>"];
    return [hasAppend ? "redirect:>>" : "redirect:>"];
  }

  const labels: string[] = [];
  for (const command of facts.commands) {
    const matched = matchCommandRule(command, rule);
    if (matched) labels.push(matched.label);
  }

  return [...new Set(labels)];
}

function pushMatches(
  matches: BashGateMatch[],
  labels: string[],
  source: BashGateMatch["source"],
  rule: BashGateRule,
): void {
  for (const label of labels) {
    if (matches.some((match) => match.label === label && match.source === source)) continue;
    matches.push({
      label,
      source,
      rule,
      reason: rule.reason,
    });
  }
}

export async function findMatchedPatterns(
  command: string,
  rulesOrConfig: BashGateRule[] | BashGateConfig | BitesConfig = {},
): Promise<BashGateMatch[]> {
  const facts = await extractBashFacts(command);

  const configuredRules = Array.isArray(rulesOrConfig)
    ? rulesOrConfig
    : "rules" in rulesOrConfig
      ? (rulesOrConfig.rules ?? [])
      : "bashGate" in rulesOrConfig
        ? resolveConfiguredRules(rulesOrConfig)
        : [];
  const builtinRules = Array.isArray(rulesOrConfig) ? [] : DEFAULT_BASH_GATE_RULES;

  const matches: BashGateMatch[] = [];

  for (const rule of configuredRules) {
    pushMatches(matches, matchRuleAgainstFacts(facts, rule), "configured", rule);
  }

  for (const rule of builtinRules) {
    pushMatches(matches, matchRuleAgainstFacts(facts, rule), "builtin", rule);
  }

  return matches;
}

export async function findMatchedPattern(
  command: string,
  rulesOrConfig: BashGateRule[] | BashGateConfig | BitesConfig = {},
): Promise<BashGateMatch | undefined> {
  return (await findMatchedPatterns(command, rulesOrConfig))[0];
}

export default function registerBashGate(pi: ExtensionAPI, configRef: { current: BitesConfig }) {
  pi.registerFlag("yolo", {
    description: "Bypass all bash-gate confirmations (useful for non-interactive / scripted runs)",
    type: "boolean",
    default: false,
  });

  let rules: BashGateRule[] = [];
  let mainAgentYolo = false;

  function syncYoloStatus(ctx: ExtensionContext): void {
    ctx.ui.setStatus("bash-gate-yolo", mainAgentYolo ? "🔥 YOLO" : undefined);
  }

  pi.on("session_start", (_event, ctx) => {
    rules = resolveEffectiveRules(configRef.current);
    mainAgentYolo = false;
    syncYoloStatus(ctx);
  });

  pi.registerShortcut("ctrl+shift+y", {
    description: "Toggle bash-gate yolo mode for the main agent",
    handler: async (ctx) => {
      mainAgentYolo = !mainAgentYolo;
      syncYoloStatus(ctx);
      ctx.ui.notify(`Bash gate ${mainAgentYolo ? "disabled" : "enabled"}.`, "info");
    },
  });

  const sessionAllowed = new Set<string>();
  const finishedSubagents = new Set<string>();

  function clearSubagentAllowances(eventData: { id: string }): void {
    const agentId = eventData.id;
    finishedSubagents.add(agentId);
    const prefix = `subagent:${agentId}:`;
    for (const key of sessionAllowed) {
      if (key.startsWith(prefix)) sessionAllowed.delete(key);
    }
  }

  pi.events.on("subagents:completed", (data) => clearSubagentAllowances(data as { id: string }));
  pi.events.on("subagents:failed", (data) => clearSubagentAllowances(data as { id: string }));

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return undefined;

    const { command } = event.input;
    if (typeof command !== "string") return undefined;

    const matchedPatterns = await findMatchedPatterns(command, rules);
    if (matchedPatterns.length === 0) return undefined;

    const matchedPatternLabels = matchedPatterns.map((match) => match.label);
    const sessionAllowKey = matchedPatternLabels.join(" && ");
    const entries = ctx.sessionManager.getEntries();
    const metadata = subagentMetadata(entries);
    const subagentPolicy = subagentBashGatePolicy(entries);
    const effectiveSessionAllowKey = metadata?.agentId
      ? `subagent:${metadata.agentId}:${sessionAllowKey}`
      : sessionAllowKey;

    // --yolo bypasses every gate; the shortcut only bypasses the main agent.
    if (pi.getFlag("yolo") || (mainAgentYolo && metadata === undefined)) return undefined;

    // Pattern was already approved for this session — run silently.
    if (sessionAllowed.has(effectiveSessionAllowKey)) return undefined;
    if (subagentPolicy === "deny") {
      return { block: true, reason: "Bash gate: gated command not allowed for this subagent." };
    }

    if (subagentPolicy === "prompt") {
      if (!metadata?.agentId || finishedSubagents.has(metadata.agentId)) {
        return { block: true, reason: "Bash gate: subagent identity is unavailable or finished." };
      }

      const gateStartMs = Date.now();
      pi.events.emit("bites:bash_gate", { cwd: ctx.cwd, command });
      try {
        const reasons = matchedPatterns.flatMap((match) =>
          match.reason === undefined ? [] : [match.reason],
        );
        const decision = await requestSubagentApproval(pi, {
          agentId: metadata.agentId,
          title: metadata.title,
          command,
          labels: matchedPatternLabels,
          reasons,
          sessionAllowKey,
        });

        if (finishedSubagents.has(metadata.agentId)) {
          return { block: true, reason: "Bash gate: subagent finished before approval." };
        }

        if (decision === "allow-session") {
          sessionAllowed.add(effectiveSessionAllowKey);
          compensateTimeout(event.input, gateStartMs);
          return undefined;
        }

        if (decision === "allow") {
          compensateTimeout(event.input, gateStartMs);
          return undefined;
        }

        return { block: true, reason: "Bash gate: command was denied by parent approval." };
      } finally {
        pi.events.emit("bites:bash_gate_resolved", { cwd: ctx.cwd, command });
      }
    }

    if (!ctx.hasUI) {
      // Non-interactive mode (e.g. `pi -p`) — block by default.
      return { block: true, reason: "Bash gate: no UI available for confirmation." };
    }

    // Snapshot the time before showing the prompt. The TUI's elapsed timer
    // starts at `tool_execution_start` (before this handler runs), so any time
    // the user spends in the gate is already ticking. We compensate by adding
    // the gate wait duration to `event.input.timeout` so the spawned process
    // still gets its full intended timeout.
    const gateStartMs = Date.now();

    pi.events.emit("bites:bash_gate", { cwd: ctx.cwd, command });

    const reasons = matchedPatterns.map((match) => match.reason).filter(Boolean);
    const prompt =
      reasons.length > 0
        ? `🔒 Bash gate — ${reasons.join("; ")} (${matchedPatternLabels.join(", ")})`
        : `🔒 Bash gate — command requires approval (${matchedPatternLabels.join(", ")})`;
    try {
      const choice = await ctx.ui.select(prompt, [
        "Allow",
        `Allow for session ("${sessionAllowKey}")`,
        "Deny",
      ]);

      if (choice?.startsWith("Allow for session")) {
        sessionAllowed.add(sessionAllowKey);
        compensateTimeout(event.input, gateStartMs);
        return undefined; // proceed
      }

      if (choice === "Allow") {
        compensateTimeout(event.input, gateStartMs);
        return undefined; // proceed just this once
      }

      return { block: true, reason: "Bash gate: command was denied by the user." };
    } finally {
      pi.events.emit("bites:bash_gate_resolved", { cwd: ctx.cwd, command });
    }
  });
}
