/**
 * Bash Gate Extension
 *
 * Prompts for confirmation before running bash commands that match any of the
 * configured patterns. Presents three choices:
 *   - Allow            → run this command once
 *   - Allow for session → run all future commands matching the same pattern automatically
 *   - Deny             → block this command and tell the model why
 *
 * Edit GUARDED_PATTERNS below to control which commands need approval.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

/**
 * Each entry is a RegExp that is tested against the full bash command string.
 * The first matching pattern is the one used for "Allow for session" tracking.
 * Add/remove patterns to taste.
 */
const GUARDED_PATTERNS: RegExp[] = [
  /\bbun\s+test\b/,
  /\bnpm\s+test\b/,
  /\bpnpm\s+test\b/,
  /\byarn\s+test\b/,
  /\bvitest\b/,
  /\bjest\b/,
  /\bpytest\b/,
  /\bgo\s+test\b/,
  /\bcargo\s+test\b/,
];

export function registerBashGate(pi: ExtensionAPI) {
  /** Patterns approved for the rest of the session (keyed by pattern source string). */
  const sessionAllowed = new Set<string>();

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return undefined;

    const command = event.input.command as string;

    const matchedPattern = GUARDED_PATTERNS.find((p) => p.test(command));
    if (!matchedPattern) return undefined;

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
