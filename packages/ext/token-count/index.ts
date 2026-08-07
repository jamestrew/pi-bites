/** Account usage for the active model provider. */

import { createHash } from "node:crypto";

import type { Api, Model, ProviderHeaders } from "@earendil-works/pi-ai";
import {
  readStoredCredential,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const CODEX_PROVIDER_ID = "openai-codex";
const COPILOT_PROVIDER_ID = "github-copilot";
const CACHE_TTL_MS = 5 * 60 * 1000;
const TIMEOUT_MS = 10_000;

export type CodexWindow = {
  usedPercent: number;
  limitWindowSeconds: number;
  resetAfterSeconds: number;
};

export type CodexUsage = {
  capturedAt: number;
  windows: CodexWindow[];
};

type CodexAccountUsage = CodexUsage & {
  provider: typeof CODEX_PROVIDER_ID;
};

type CopilotMeteredUsage = {
  provider: typeof COPILOT_PROVIDER_ID;
  capturedAt: number;
  unlimited: false;
  resetsAt?: number;
  overage: boolean;
} & (
  | { display: "credits"; used: number; entitlement: number; remainingPercent?: number }
  | { display: "percentage"; remainingPercent: number }
);

type CopilotUnlimitedUsage = {
  provider: typeof COPILOT_PROVIDER_ID;
  capturedAt: number;
  unlimited: true;
};

type CopilotAccountUsage = CopilotMeteredUsage | CopilotUnlimitedUsage;
export type AccountUsage = CodexAccountUsage | CopilotAccountUsage;

export type AccountUsageSource =
  | {
      key: string;
      provider: typeof CODEX_PROVIDER_ID;
      query(): Promise<CodexAccountUsage | undefined>;
    }
  | {
      key: string;
      provider: typeof COPILOT_PROVIDER_ID;
      query(): Promise<CopilotAccountUsage | undefined>;
    };

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type TokenCountDependencies = {
  now?: () => number;
  resolveSource?: (
    ctx: ExtensionContext,
  ) => AccountUsageSource | undefined | Promise<AccountUsageSource | undefined>;
};

export function formatCodexUsage(usage: CodexUsage): string | undefined {
  return formatAccountUsage({ provider: CODEX_PROVIDER_ID, ...usage });
}

export function formatAccountUsage(
  usage: AccountUsage | undefined,
  now = Date.now(),
): string | undefined {
  if (!usage) return undefined;
  if (usage.provider === CODEX_PROVIDER_ID) {
    const parts = usage.windows.map(
      (window) =>
        `${formatCodexWindowLabel(window.limitWindowSeconds)}: ${window.usedPercent.toFixed(0)}% (${formatResetDuration(window.resetAfterSeconds)})`,
    );
    return parts.length > 0 ? `codex: ${parts.join(" ")}` : undefined;
  }

  if (usage.unlimited) return "copilot: credits unlimited";
  const fact =
    usage.display === "credits"
      ? `${formatNumber(usage.used)}/${formatNumber(usage.entitlement)} credits`
      : `${usage.remainingPercent.toFixed(0)}% left`;
  const details: string[] = [];
  if (usage.display === "credits" && usage.remainingPercent !== undefined) {
    details.push(`${usage.remainingPercent.toFixed(0)}% left`);
  }
  if (usage.resetsAt !== undefined) details.push(formatDaysUntil(usage.resetsAt, now));
  if (usage.overage) details.push("overage");
  return `copilot: ${fact}${details.length > 0 ? ` (${details.join(", ")})` : ""}`;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value);
}

function formatDaysUntil(resetsAt: number, now: number): string {
  return `${Math.max(0, Math.ceil((resetsAt - now) / 86_400_000))}d`;
}

function formatCodexWindowLabel(seconds: number): string {
  const days = seconds / 86_400;
  if (Number.isInteger(days) && days >= 1) return `${days}d`;
  const hours = seconds / 3_600;
  if (Number.isInteger(hours) && hours >= 1) return `${hours}h`;
  return `${seconds}s`;
}

function formatResetDuration(seconds: number): string {
  const safeSeconds = Math.max(0, seconds);
  if (safeSeconds < 86_400) return `${(safeSeconds / 3_600).toFixed(1)}h`;
  const days = Math.floor(safeSeconds / 86_400);
  const remainingHours = (safeSeconds - days * 86_400) / 3_600;
  return `${days}d${remainingHours.toFixed(1)}h`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function tokenBillingEnabled(value: unknown): boolean {
  return value === true || (isRecord(value) && value.enabled === true);
}

export function normalizeCopilotUsage(
  payload: unknown,
  capturedAt = Date.now(),
): CopilotAccountUsage | undefined {
  if (!isRecord(payload) || !tokenBillingEnabled(payload.token_based_billing)) return undefined;
  const snapshots = isRecord(payload.quota_snapshots) ? payload.quota_snapshots : undefined;
  const snapshot = snapshots?.premium_interactions;
  if (!isRecord(snapshot)) return undefined;

  const entitlementRaw = finiteNumber(snapshot.entitlement);
  const remainingRaw = finiteNumber(snapshot.quota_remaining) ?? finiteNumber(snapshot.remaining);
  const unlimited = snapshot.unlimited === true || entitlementRaw === -1 || remainingRaw === -1;
  if (unlimited) {
    return { provider: COPILOT_PROVIDER_ID, capturedAt, unlimited: true };
  }

  const entitlement =
    entitlementRaw !== undefined && entitlementRaw > 0 ? entitlementRaw : undefined;
  const remainingPercentRaw =
    finiteNumber(snapshot.percent_remaining) ??
    (entitlement !== undefined && remainingRaw !== undefined
      ? (remainingRaw / entitlement) * 100
      : undefined);
  const remainingPercent =
    remainingPercentRaw === undefined ? undefined : Math.max(0, Math.min(100, remainingPercentRaw));
  const reset = payload.quota_reset_date_utc ?? payload.quota_reset_date;
  const resetsAt =
    typeof reset === "string" && Number.isFinite(Date.parse(reset)) ? Date.parse(reset) : undefined;
  const overageCount = finiteNumber(snapshot.overage_count);
  const overage =
    (overageCount !== undefined && overageCount > 0) ||
    (remainingRaw !== undefined && remainingRaw < 0);
  if (entitlement !== undefined && remainingRaw !== undefined) {
    return {
      provider: COPILOT_PROVIDER_ID,
      capturedAt,
      display: "credits",
      used: Math.max(0, Math.min(entitlement, entitlement - remainingRaw)),
      entitlement,
      remainingPercent,
      resetsAt,
      unlimited: false,
      overage,
    };
  }
  if (remainingPercent === undefined) return undefined;
  return {
    provider: COPILOT_PROVIDER_ID,
    capturedAt,
    display: "percentage",
    remainingPercent,
    resetsAt,
    unlimited: false,
    overage,
  };
}

export function normalizeCodexUsage(payload: unknown): CodexUsage {
  const rateLimit =
    isRecord(payload) && isRecord(payload.rate_limit) ? payload.rate_limit : undefined;
  const windows = [
    normalizeCodexWindow(rateLimit?.primary_window),
    normalizeCodexWindow(rateLimit?.secondary_window),
  ].filter((window): window is CodexWindow => window !== undefined);
  return { capturedAt: Date.now(), windows };
}

function normalizeCodexWindow(value: unknown): CodexWindow | undefined {
  if (!isRecord(value)) return undefined;
  const usedPercent = finiteNumber(value.used_percent);
  const limitWindowSeconds = finiteNumber(value.limit_window_seconds);
  const resetAfterSeconds = finiteNumber(value.reset_after_seconds);
  if (
    usedPercent === undefined ||
    limitWindowSeconds === undefined ||
    resetAfterSeconds === undefined
  )
    return undefined;
  return { usedPercent, limitWindowSeconds, resetAfterSeconds };
}

type CopilotSourceOptions = {
  fetcher?: Fetcher;
  modelHeaders?: ProviderHeaders;
};

function readCopilotSource(
  now: () => number,
  modelHeaders: ProviderHeaders | undefined,
): AccountUsageSource | undefined {
  return createCopilotSource(readStoredCredential(COPILOT_PROVIDER_ID), now, { modelHeaders });
}

export function createCopilotSource(
  credential: unknown,
  now: () => number,
  options: CopilotSourceOptions = {},
): AccountUsageSource | undefined {
  if (
    !isRecord(credential) ||
    credential.type !== "oauth" ||
    typeof credential.refresh !== "string"
  )
    return undefined;
  const domain = normalizeDomain(credential.enterpriseUrl) ?? "github.com";
  const token = credential.refresh;
  const fingerprint = createHash("sha256").update(token).digest("hex");
  return {
    key: `${domain}:${fingerprint}`,
    provider: COPILOT_PROVIDER_ID,
    query: async () => {
      // This route and its API-version header are an undocumented first-party Copilot contract.
      const response = await fetchWithTimeout(
        `https://api.${domain}/copilot_internal/user`,
        {
          headers: mergeHeaders(options.modelHeaders, {
            Accept: "application/json",
            Authorization: `token ${token}`,
            "X-GitHub-Api-Version": "2026-06-01",
          }),
        },
        options.fetcher,
      );
      if (!response.ok) return undefined;
      return normalizeCopilotUsage(await response.json(), now());
    },
  };
}

function mergeHeaders(
  base: ProviderHeaders | undefined,
  overrides: Record<string, string>,
): Record<string, string> {
  const merged = Object.fromEntries(
    Object.entries(base ?? {}).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  for (const [name, value] of Object.entries(overrides)) {
    for (const existing of Object.keys(merged)) {
      if (existing.toLowerCase() === name.toLowerCase()) delete merged[existing];
    }
    merged[name] = value;
  }
  return merged;
}

function normalizeDomain(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    return new URL(value.includes("://") ? value : `https://${value}`).hostname;
  } catch {
    return undefined;
  }
}

function resolveDefaultSource(
  ctx: ExtensionContext,
  now: () => number,
): AccountUsageSource | undefined | Promise<AccountUsageSource | undefined> {
  if (ctx.model?.provider === COPILOT_PROVIDER_ID) return readCopilotSource(now, ctx.model.headers);
  if (ctx.model?.provider !== CODEX_PROVIDER_ID) return undefined;
  return resolveCodexSource(ctx);
}

async function resolveCodexSource(ctx: ExtensionContext): Promise<AccountUsageSource | undefined> {
  const model = ctx.model as Model<Api>;
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) return undefined;
  const headers = mergeHeaders(auth.headers, {});
  if (!getHeader(headers, "Authorization") && auth.apiKey)
    headers.Authorization = `Bearer ${auth.apiKey}`;
  const authorization = getHeader(headers, "Authorization");
  if (!authorization) return undefined;
  const fingerprint = createHash("sha256").update(authorization).digest("hex");
  return {
    key: `${CODEX_PROVIDER_ID}:${fingerprint}`,
    provider: CODEX_PROVIDER_ID,
    query: async () => {
      const response = await fetchWithTimeout("https://chatgpt.com/backend-api/wham/usage", {
        headers,
      });
      if (!response.ok) return undefined;
      const usage = normalizeCodexUsage(await response.json());
      return { provider: CODEX_PROVIDER_ID, ...usage };
    },
  };
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  fetcher: Fetcher = fetch,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetcher(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function getHeader(headers: Record<string, string>, name: string): string | undefined {
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return entry?.[1];
}

export default function registerTokenCount(
  pi: ExtensionAPI,
  dependencies: TokenCountDependencies = {},
): void {
  const now = dependencies.now ?? Date.now;
  const resolveSource = dependencies.resolveSource ?? ((ctx) => resolveDefaultSource(ctx, now));
  const cache = new Map<string, AccountUsage>();
  const inFlight = new Map<string, Promise<AccountUsage | undefined>>();
  const activeKeys = new Map<AccountUsageSource["provider"], string>();
  let generation = 0;

  const setStatus = (ctx: ExtensionContext, usage?: AccountUsage) => {
    const text = formatAccountUsage(usage, now());
    ctx.ui.setStatus("token-count", text ? ctx.ui.theme.fg("dim", text) : undefined);
  };

  const update = async (ctx: ExtensionContext) => {
    const requestGeneration = ++generation;
    setStatus(ctx);
    const modelKey = ctx.model && `${ctx.model.provider}/${ctx.model.id}`;
    const provider = ctx.model?.provider;
    const resolving = resolveSource(ctx);
    const source = resolving instanceof Promise ? await resolving : resolving;
    const resolvedModelKey = ctx.model && `${ctx.model.provider}/${ctx.model.id}`;
    if (
      !source ||
      source.provider !== provider ||
      resolvedModelKey !== modelKey ||
      requestGeneration !== generation
    )
      return;

    const previousKey = activeKeys.get(source.provider);
    if (previousKey && previousKey !== source.key) {
      cache.delete(previousKey);
      inFlight.delete(previousKey);
    }
    activeKeys.set(source.provider, source.key);

    const cached = cache.get(source.key);
    if (cached && now() - cached.capturedAt < CACHE_TTL_MS) {
      setStatus(ctx, cached);
      return;
    }
    let pending = inFlight.get(source.key);
    if (!pending) {
      pending = (async () => {
        try {
          const usage = await source.query().catch(() => undefined);
          if (
            usage &&
            activeKeys.get(source.provider) === source.key &&
            inFlight.get(source.key) === pending
          )
            cache.set(source.key, usage);
          return usage;
        } finally {
          if (inFlight.get(source.key) === pending) inFlight.delete(source.key);
        }
      })();
      inFlight.set(source.key, pending);
    }
    const usage = await pending;
    const activeModelKey = ctx.model && `${ctx.model.provider}/${ctx.model.id}`;
    if (!usage || requestGeneration !== generation || activeModelKey !== modelKey) return;
    setStatus(ctx, usage);
  };

  pi.on("session_start", async (_event, ctx) => update(ctx));
  pi.on("turn_end", async (_event, ctx) => update(ctx));
  pi.on("session_compact", async (_event, ctx) => update(ctx));
  pi.on("model_select", async (_event, ctx) => update(ctx));
  pi.on("session_shutdown", (_event, ctx) => {
    generation++;
    setStatus(ctx);
  });
}
