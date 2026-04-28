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

function resolvePatterns(config: SnacksConfig): RegExp[] {
  const raw = config.bashGate?.patterns;
  if (!raw || raw.length === 0) return [];
  return raw.map((p) => new RegExp(p));
}

export function registerBashGate(pi: ExtensionAPI, configRef: { current: SnacksConfig }) {
  pi.registerFlag("yolo", {
    description: "Bypass all bash-gate confirmations (useful for non-interactive / scripted runs)",
    type: "boolean",
    default: false,
  });

  /** Patterns approved for the rest of the session (keyed by pattern source string). */
  const sessionAllowed = new Set<string>();
  const patterns = resolvePatterns(configRef.current);

  if (patterns.length === 0) return;

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return undefined;

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

    const choice = await ctx.ui.select(
      `🔒 Bash gate — command requires approval:\n\n  ${command}\n`,
      ["Allow", "Allow for session", "Deny"],
    );

    if (choice === "Allow for session") {
      sessionAllowed.add(matchedPattern.source);
      return undefined; // proceed
    }

    if (choice === "Allow") {
      return undefined; // proceed just this once
    }

    // "Deny" or dialog dismissed
    return { block: true, reason: "Bash gate: command was denied by the user." };
  });
}
