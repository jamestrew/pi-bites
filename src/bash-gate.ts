/**
 * Bash Gate Extension
 *
 * Prompts for confirmation before running bash commands that match any of the
 * configured patterns. Presents three choices:
 *   - Allow            → run this command once
 *   - Allow for session → run all future commands matching the same pattern automatically
 *   - Deny             → block this command and tell the model why
 *
 * Default patterns guard common test runners. Override via pi-snacks.json:
 *
 * ```json
 * {
 *   "bashGate": {
 *     "patterns": ["\\brm\\s+-rf\\b", "\\bsudo\\b"]
 *   }
 * }
 * ```
 *
 * Providing `patterns` replaces the built-in list entirely.
 *
 * Pass `--yolo` on the CLI to bypass all gates entirely — useful for
 * non-interactive / scripted runs where no UI is available:
 *
 * ```bash
 * pi --yolo -p "run the tests"
 * ```
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { SnacksConfig } from "./config.js";

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

function resolvePatterns(config: SnacksConfig): RegExp[] {
  const raw = config.bashGate?.patterns;
  if (!raw || raw.length === 0) return [];
  return raw.map((p) => new RegExp(p));
}

export default function registerBashGate(pi: ExtensionAPI, configRef: { current: SnacksConfig }) {
  pi.registerFlag("yolo", {
    description: "Bypass all bash-gate confirmations (useful for non-interactive / scripted runs)",
    type: "boolean",
    default: false,
  });

  let patterns: RegExp[] = [];

  pi.on("session_start", (_event, _ctx) => {
    patterns = resolvePatterns(configRef.current);
  });

  const sessionAllowed = new Set<string>();

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return undefined;
    if (patterns.length === 0) return undefined;

    const command = event.input.command as string;

    const matchedPattern = patterns.find((p) => p.test(command));
    if (!matchedPattern) return undefined;

    // --yolo flag: skip all gates.
    if (pi.getFlag("yolo")) return undefined;

    // Pattern was already approved for this session — run silently.
    if (sessionAllowed.has(matchedPattern.source)) return undefined;

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

    const matchLabel = command.match(matchedPattern)?.[0] ?? matchedPattern.source;
    const choice = await ctx.ui.select(`🔒 Bash gate — command requires approval`, [
      "Allow",
      `Allow for session ("${matchLabel}")`,
      "Deny",
    ]);

    if (choice?.startsWith("Allow for session")) {
      sessionAllowed.add(matchedPattern.source);
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
