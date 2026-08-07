import { afterEach, expect, test, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import registerTokenCount, {
  createCopilotSource,
  formatAccountUsage,
  formatCodexUsage,
  normalizeCodexUsage,
  normalizeCopilotUsage,
  type AccountUsageSource,
} from "./index.js";

const NOW = Date.parse("2026-07-06T00:00:00Z");

afterEach(() => vi.unstubAllGlobals());

const tokenBillingPayload = {
  token_based_billing: { enabled: true },
  quota_reset_date_utc: "2026-08-01T00:00:00Z",
  quota_snapshots: {
    premium_interactions: {
      entitlement: 1_000,
      quota_remaining: 588,
      percent_remaining: 58.8,
      overage_permitted: true,
      overage_count: 0,
      unlimited: false,
    },
  },
  unknown_future_field: { ignored: true },
};

test("formatCodexUsage renders used percent and reset duration", () => {
  expect(
    formatCodexUsage({
      capturedAt: 0,
      windows: [
        { usedPercent: 0, limitWindowSeconds: 18_000, resetAfterSeconds: 17_640 },
        { usedPercent: 3, limitWindowSeconds: 604_800, resetAfterSeconds: 231_480 },
      ],
    }),
  ).toBe("codex: 5h: 0% (4.9h) 7d: 3% (2d16.3h)");
});

test("normalizeCodexUsage preserves Codex rate limit window fields", () => {
  const usage = normalizeCodexUsage({
    rate_limit: {
      primary_window: {
        used_percent: 7,
        limit_window_seconds: 18_000,
        reset_after_seconds: 16_083,
      },
      secondary_window: {
        used_percent: 16,
        limit_window_seconds: 604_800,
        reset_after_seconds: 86_063,
      },
    },
  });

  expect(usage.windows).toEqual([
    { usedPercent: 7, limitWindowSeconds: 18_000, resetAfterSeconds: 16_083 },
    { usedPercent: 16, limitWindowSeconds: 604_800, resetAfterSeconds: 86_063 },
  ]);
});

test.each([
  [
    "resolved authorization",
    {
      ok: true,
      apiKey: "fallback-key",
      headers: {
        authorization: "Bearer resolved",
        "X-Keep": "yes",
        "X-Delete": null,
      },
    },
    { authorization: "Bearer resolved", "X-Keep": "yes" },
  ],
  [
    "API-key fallback for a null authorization marker",
    {
      ok: true,
      apiKey: "fallback-key",
      headers: { Authorization: null, "X-Keep": "yes" },
    },
    { Authorization: "Bearer fallback-key", "X-Keep": "yes" },
  ],
])(
  "Codex direct fetch filters nullable headers and preserves %s",
  async (_name, auth, expected) => {
    const handlers = new Map<string, (...args: unknown[]) => Promise<void>>();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ rate_limit: {} })));
    vi.stubGlobal("fetch", fetchMock);
    const pi = {
      on: (event: string, handler: (...args: unknown[]) => Promise<void>) =>
        handlers.set(event, handler),
    };
    const ctx = {
      model: { provider: "openai-codex", id: "codex", api: "openai-responses" },
      modelRegistry: { getApiKeyAndHeaders: async () => auth },
      ui: { setStatus: vi.fn(), theme: { fg: (_color: string, text: string) => text } },
    } as unknown as ExtensionContext;
    registerTokenCount(pi as never);

    await handlers.get("session_start")!({}, ctx);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://chatgpt.com/backend-api/wham/usage",
      expect.objectContaining({ headers: expected }),
    );
  },
);

test.each([
  [
    "individual token billing",
    tokenBillingPayload,
    { used: 412, entitlement: 1_000, remainingPercent: 58.8, unlimited: false, overage: false },
  ],
  [
    "numeric strings and missing optional fields",
    {
      token_based_billing: true,
      quota_snapshots: {
        premium_interactions: { entitlement: "300", remaining: "75", percent_remaining: "25" },
      },
    },
    { used: 225, entitlement: 300, remainingPercent: 25, unlimited: false, overage: false },
  ],
  [
    "organization user limit",
    {
      token_based_billing: true,
      copilot_plan: "enterprise",
      quota_snapshots: {
        premium_interactions: {
          entitlement: 3_900,
          quota_remaining: 3_875.5,
          percent_remaining: 99.3,
        },
      },
    },
    { used: 24.5, entitlement: 3_900, remainingPercent: 99.3, unlimited: false, overage: false },
  ],
  [
    "unlimited sentinel",
    {
      token_based_billing: { enabled: true },
      quota_snapshots: { premium_interactions: { entitlement: -1, remaining: -1 } },
    },
    { unlimited: true },
  ],
  [
    "overage clamps included usage",
    {
      token_based_billing: true,
      quota_snapshots: {
        premium_interactions: {
          entitlement: 100,
          remaining: -12,
          percent_remaining: -12,
          overage_count: 12,
        },
      },
    },
    { used: 100, entitlement: 100, remainingPercent: 0, unlimited: false, overage: true },
  ],
])("normalizes Copilot %s", (_name, payload, expected) => {
  expect(normalizeCopilotUsage(payload, NOW)).toMatchObject(expected);
});

test.each([
  [
    "legacy billing",
    {
      token_based_billing: false,
      quota_snapshots: { premium_interactions: { entitlement: 100, remaining: 50 } },
    },
  ],
  [
    "billing marker absent",
    { quota_snapshots: { premium_interactions: { entitlement: 100, remaining: 50 } } },
  ],
  ["snapshot absent", { token_based_billing: true }],
  ...["wat", "   ", false, []].map((entitlement): [string, unknown] => [
    `invalid entitlement ${JSON.stringify(entitlement)}`,
    {
      token_based_billing: true,
      quota_snapshots: { premium_interactions: { entitlement, remaining: null } },
    },
  ]),
])("omits Copilot credits for %s", (_name, payload) => {
  expect(normalizeCopilotUsage(payload, NOW)).toBeUndefined();
});

test.each([
  [normalizeCopilotUsage(tokenBillingPayload, NOW), "copilot: 412/1,000 credits (59% left, 26d)"],
  [
    {
      provider: "github-copilot",
      capturedAt: NOW,
      display: "percentage",
      remainingPercent: 25,
      unlimited: false,
      overage: false,
    },
    "copilot: 25% left",
  ],
  [
    {
      provider: "github-copilot",
      capturedAt: NOW,
      unlimited: false,
      display: "credits",
      used: 100,
      entitlement: 100,
      remainingPercent: 0,
      overage: true,
    },
    "copilot: 100/100 credits (0% left, overage)",
  ],
  [{ provider: "github-copilot", capturedAt: NOW, unlimited: true }, "copilot: credits unlimited"],
  [undefined, undefined],
] as const)("formats normalized account usage", (usage, expected) => {
  expect(formatAccountUsage(usage, NOW)).toBe(expected);
});

test("Copilot source uses the stored GitHub credential and enterprise domain", async () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(tokenBillingPayload)));
  const source = createCopilotSource(
    { type: "oauth", refresh: "github-token", enterpriseUrl: "https://octocorp.ghe.com" },
    () => NOW,
    {
      fetcher: fetchMock,
      modelHeaders: {
        "User-Agent": "canonical-agent",
        "Copilot-Integration-Id": "vscode-chat",
        authorization: "token stale-token",
        accept: "text/plain",
        "x-github-api-version": "stale-version",
      },
    },
  );

  await expect(source?.query()).resolves.toMatchObject({
    provider: "github-copilot",
    used: 412,
  });
  expect(fetchMock).toHaveBeenCalledWith(
    "https://api.octocorp.ghe.com/copilot_internal/user",
    expect.objectContaining({
      headers: {
        Accept: "application/json",
        Authorization: "token github-token",
        "Copilot-Integration-Id": "vscode-chat",
        "User-Agent": "canonical-agent",
        "X-GitHub-Api-Version": "2026-06-01",
      },
    }),
  );
});

test("account switches cannot cache stale results or disrupt newer in-flight requests", async () => {
  const handlers = new Map<string, (...args: unknown[]) => Promise<void>>();
  const pi = {
    on: vi.fn((event: string, handler: (...args: unknown[]) => Promise<void>) =>
      handlers.set(event, handler),
    ),
  };
  const deferred = () => {
    let resolve!: (usage: ReturnType<typeof normalizeCopilotUsage>) => void;
    return {
      promise: new Promise<ReturnType<typeof normalizeCopilotUsage>>((done) => (resolve = done)),
      resolve,
    };
  };
  const oldA = deferred();
  const accountB = deferred();
  const newA = deferred();
  const accountQueries = { A: vi.fn(), B: vi.fn() };
  accountQueries.A.mockReturnValueOnce(oldA.promise).mockReturnValueOnce(newA.promise);
  accountQueries.B.mockReturnValue(accountB.promise);

  let account: "A" | "B" = "A";
  const statuses: Array<string | undefined> = [];
  const ctx = {
    model: { provider: "github-copilot", id: "model" },
    ui: {
      setStatus: (_key: string, value?: string) => statuses.push(value),
      theme: { fg: (_color: string, value: string) => value },
    },
  };
  registerTokenCount(pi as never, {
    now: () => NOW,
    resolveSource: (): AccountUsageSource => ({
      key: `github.com/${account}`,
      provider: "github-copilot",
      query: accountQueries[account],
    }),
  });

  const oldRequest = handlers.get("turn_end")!({}, ctx);
  account = "B";
  const bRequest = handlers.get("turn_end")!({}, ctx);
  account = "A";
  const newRequest = handlers.get("turn_end")!({}, ctx);

  oldA.resolve(normalizeCopilotUsage(tokenBillingPayload, NOW));
  await oldRequest;
  const concurrent = handlers.get("turn_end")!({}, ctx);
  expect(statuses.at(-1)).toBeUndefined();
  expect(accountQueries.A).toHaveBeenCalledTimes(2);

  newA.resolve(
    normalizeCopilotUsage(
      {
        ...tokenBillingPayload,
        quota_snapshots: {
          premium_interactions: {
            ...tokenBillingPayload.quota_snapshots.premium_interactions,
            quota_remaining: 900,
            percent_remaining: 90,
          },
        },
      },
      NOW,
    ),
  );
  await Promise.all([newRequest, concurrent]);
  expect(statuses.at(-1)).toBe("copilot: 100/1,000 credits (90% left, 26d)");

  accountB.resolve(undefined);
  await bRequest;
});

test("extension lifecycle selects providers, caches, deduplicates, and suppresses stale failures", async () => {
  const handlers = new Map<string, (...args: unknown[]) => Promise<void>>();
  const pi = {
    on: vi.fn((event: string, handler: (...args: unknown[]) => Promise<void>) =>
      handlers.set(event, handler),
    ),
  };
  let provider = "github-copilot";
  const statuses: Array<string | undefined> = [];
  const ctx = {
    get model() {
      return { provider, id: "model" };
    },
    ui: {
      setStatus: (_key: string, value?: string) => statuses.push(value),
      theme: { fg: (_color: string, value: string) => value },
    },
  };
  let account = "account-1";
  let rejectQuery = false;
  let resolveQuery!: (usage: ReturnType<typeof normalizeCopilotUsage>) => void;
  const query = vi.fn(() =>
    rejectQuery
      ? Promise.reject(new Error("auth failed"))
      : new Promise<ReturnType<typeof normalizeCopilotUsage>>((resolve) => {
          resolveQuery = resolve;
        }),
  );

  registerTokenCount(pi as never, {
    now: () => NOW,
    resolveSource: (candidate): AccountUsageSource | undefined =>
      candidate.model?.provider === "github-copilot"
        ? { key: `github.com/${account}`, provider: "github-copilot", query }
        : undefined,
  });

  const start = handlers.get("session_start")!({}, ctx);
  const concurrent = handlers.get("turn_end")!({}, ctx);
  expect(query).toHaveBeenCalledTimes(1);
  resolveQuery(normalizeCopilotUsage(tokenBillingPayload, NOW));
  await Promise.all([start, concurrent]);
  expect(statuses.at(-1)).toBe("copilot: 412/1,000 credits (59% left, 26d)");

  await handlers.get("turn_end")!({}, ctx);
  expect(query).toHaveBeenCalledTimes(1);

  provider = "openai-codex";
  await handlers.get("model_select")!({}, ctx);
  expect(statuses.at(-1)).toBeUndefined();

  account = "account-2";
  provider = "github-copilot";
  const stale = handlers.get("turn_end")!({}, ctx);
  expect(query).toHaveBeenCalledTimes(2);
  provider = "anthropic";
  await handlers.get("model_select")!({}, ctx);
  resolveQuery(normalizeCopilotUsage(tokenBillingPayload, NOW));
  await stale;
  expect(statuses.at(-1)).toBeUndefined();

  account = "account-3";
  rejectQuery = true;
  provider = "github-copilot";
  await handlers.get("turn_end")!({}, ctx);
  expect(statuses.at(-1)).toBeUndefined();
});
