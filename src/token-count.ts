/**
 * Token Count Statusline
 *
 * Shows the raw context token count as a status-bar entry after each agent
 * turn, complementing the built-in `0.0%/1.0M` percentage display.
 *
 * Example output in the footer extension line:
 *   ctx: 42k / 200k
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const CODEX_PROVIDER_ID = "openai-codex";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_CACHE_TTL_MS = 5 * 60 * 1000;
const CODEX_TIMEOUT_MS = 10_000;

type CodexWindow = {
  usedPercent: number;
  label: "5h" | "wk";
};

type CodexUsage = {
  capturedAt: number;
  windows: CodexWindow[];
};

let codexCache: CodexUsage | undefined;
let codexRequestId = 0;

function formatTokens(count: number): string {
  if (count < 1_000) return count.toString();
  if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

function formatCodexUsage(usage: CodexUsage): string | undefined {
  const parts = usage.windows.map((window) => {
    const remaining = Math.max(0, Math.min(100, 100 - window.usedPercent));
    return `${remaining.toFixed(0)}% ${window.label}`;
  });
  return parts.length > 0 ? `codex: ${parts.join(" ")}` : undefined;
}

function tokenStatusText(ctx: ExtensionContext): string | undefined {
  const usage = ctx.getContextUsage();
  if (!usage) return undefined;

  const tokenStr = usage.tokens !== null ? formatTokens(usage.tokens) : "?";
  const windowStr = formatTokens(usage.contextWindow);
  return `ctx: ${tokenStr}/${windowStr}`;
}

function setTokenStatus(ctx: ExtensionContext, codexUsage?: CodexUsage): void {
  const parts = [
    tokenStatusText(ctx),
    codexUsage ? formatCodexUsage(codexUsage) : undefined,
  ].filter(Boolean);
  if (parts.length === 0) return;

  ctx.ui.setStatus("token-count", ctx.ui.theme.fg("dim", parts.join(" | ")));
}

async function updateTokenStatus(ctx: ExtensionContext): Promise<void> {
  setTokenStatus(ctx);

  if (!isOpenAICodex(ctx)) return;

  const cached = codexCache && Date.now() - codexCache.capturedAt < CODEX_CACHE_TTL_MS;
  if (cached) {
    setTokenStatus(ctx, codexCache);
    return;
  }

  const requestId = ++codexRequestId;
  const codexUsage = await queryCodexUsage(ctx).catch(() => undefined);
  if (!codexUsage || requestId !== codexRequestId || !isOpenAICodex(ctx)) return;

  codexCache = codexUsage;
  setTokenStatus(ctx, codexUsage);
}

function isOpenAICodex(ctx: ExtensionContext): boolean {
  return ctx.model?.provider === CODEX_PROVIDER_ID;
}

async function queryCodexUsage(ctx: ExtensionContext): Promise<CodexUsage> {
  if (!ctx.model) throw new Error("Missing model");

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
  if (!auth.ok) throw new Error(auth.error);

  const headers = { ...auth.headers } as Record<string, string>;
  if (!hasHeader(headers, "Authorization") && auth.apiKey) {
    headers.Authorization = `Bearer ${auth.apiKey}`;
  }
  if (!hasHeader(headers, "Authorization")) throw new Error("Missing Codex auth header");

  const response = await fetchWithTimeout(CODEX_USAGE_URL, { headers }, CODEX_TIMEOUT_MS);
  if (!response.ok) throw new Error(`Codex usage returned ${response.status}`);

  return normalizeCodexUsage(await response.json());
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeCodexUsage(payload: any): CodexUsage {
  const rateLimit = payload?.rate_limit;
  const primary = rateLimit?.primary_window;
  const secondary = rateLimit?.secondary_window;
  const windows = [
    normalizeCodexWindow(primary, "5h"),
    normalizeCodexWindow(secondary, "wk"),
  ].filter((window): window is CodexWindow => window !== undefined);

  return { capturedAt: Date.now(), windows };
}

function normalizeCodexWindow(value: any, label: CodexWindow["label"]): CodexWindow | undefined {
  const usedPercent = Number(value?.used_percent);
  return Number.isFinite(usedPercent) ? { usedPercent, label } : undefined;
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === name.toLowerCase());
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
