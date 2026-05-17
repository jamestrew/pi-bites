/**
 * Token Count Statusline
 *
 * Shows the raw context token count as a status-bar entry after each agent
 * turn, complementing the built-in `0.0%/1.0M` percentage display.
 *
 * Example output in the footer extension line:
 *   ctx: 42k / 200k
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

function formatTokens(count: number): string {
  if (count < 1_000) return count.toString();
  if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

function updateTokenStatus(ctx: ExtensionContext): void {
  const usage = ctx.getContextUsage();
  if (!usage) return;

  const tokenStr = usage.tokens !== null ? formatTokens(usage.tokens) : "?";
  const windowStr = formatTokens(usage.contextWindow);
  const text = `ctx: ${tokenStr}/${windowStr}`;

  ctx.ui.setStatus("token-count", ctx.ui.theme.fg("dim", text));
}

export default function registerTokenCount(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    updateTokenStatus(ctx);
  });

  pi.on("turn_end", async (_event, ctx) => {
    updateTokenStatus(ctx);
  });

  pi.on("session_compact", async (_event, ctx) => {
    updateTokenStatus(ctx);
  });
}
