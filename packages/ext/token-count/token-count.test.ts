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
        "ChatGPT-Account-Id": "account",
        "X-Delete": null,
      },
    },
    { authorization: "Bearer resolved", "X-Keep": "yes", "ChatGPT-Account-Id": "account" },
  ],
  [
    "API-key fallback for a null authorization marker",
    {
      ok: true,
      apiKey: "fallback-key",
      headers: { Authorization: null, "X-Keep": "yes", "ChatGPT-Account-Id": "account" },
    },
    { Authorization: "Bearer fallback-key", "X-Keep": "yes", "ChatGPT-Account-Id": "account" },
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
      modelRegistry: { getProviderAuth: async () => ({ source: "OAuth", auth }) },
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

test.each(["auth", "usage", "unavailable status"])(
  "session replacement retires pending %s without reading stale context",
  async (phase) => {
    const handlers = new Map<string, (...args: unknown[]) => Promise<void>>();
    const statuses: Array<string | undefined> = [];
    let stale = false;
    const ctx = {
      get model() {
        if (stale) throw new Error("stale model getter");
        return { provider: "github-copilot", id: "model" };
      },
      get ui() {
        if (stale) throw new Error("stale ui getter");
        return {
          setStatus: (_key: string, value?: string) => statuses.push(value),
          theme: { fg: (_color: string, value: string) => value },
        };
      },
    };
    let finish!: () => void;
    const deferred = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const source: AccountUsageSource = {
      key: "old-account",
      provider: "github-copilot",
      query: async () => {
        if (phase === "usage") await deferred;
        return normalizeCopilotUsage(tokenBillingPayload, NOW);
      },
    };
    registerTokenCount(
      {
        on: (event: string, handler: (...args: unknown[]) => Promise<void>) =>
          handlers.set(event, handler),
      } as never,
      {
        resolveSource: () => {
          if (phase === "unavailable status")
            return deferred.then(() => ({ status: "usage unavailable" }));
          return phase === "auth" ? deferred.then(() => source) : source;
        },
        now: () => NOW,
      },
    );
    const pending = handlers.get("session_start")!({}, ctx);
    stale = true;
    await handlers.get("session_shutdown")!(
      {},
      {
        model: { provider: "anthropic", id: "other" },
        ui: {
          setStatus: (_key: string, value?: string) => statuses.push(value),
          theme: { fg: (_color: string, value: string) => value },
        },
      },
    );
    finish();
    await expect(pending).resolves.toBeUndefined();
    expect(statuses).toEqual([undefined, undefined]);
  },
);

test.each([true, false])(
  "direct OpenAI OAuth=%s never sends credentials to subscription usage endpoints",
  async (oauth) => {
    const handlers = new Map<string, (...args: unknown[]) => Promise<void>>();
    const setStatus = vi.fn();
    const fetchMock = vi.fn();
    const getApiKeyAndHeaders = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    registerTokenCount({
      on: (event: string, handler: (...args: unknown[]) => Promise<void>) =>
        handlers.set(event, handler),
    } as never);
    await handlers.get("session_start")!(
      {},
      {
        model: { provider: "openai", id: "gpt-6.1-sol", api: "openai-responses" },
        modelRegistry: {
          // A stale registry snapshot must not authorize a runtime API-key override.
          isUsingOAuth: () => true,
          getProviderAuth: async () => ({
            source: oauth ? "OAuth" : "runtime",
            auth: { apiKey: "token" },
          }),
          getProvider: () => ({ auth: { oauth: { isSubscription: true } } }),
          getApiKeyAndHeaders,
        },
        ui: { setStatus, theme: { fg: (_color: string, value: string) => value } },
      },
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getApiKeyAndHeaders).not.toHaveBeenCalled();
    expect(setStatus).toHaveBeenLastCalledWith(
      "token-count",
      oauth
        ? "openai: subscription usage unavailable; https://chatgpt.com/settings/usage"
        : undefined,
    );
  },
);

test.each([
  ["OAuth", "OAuth", true],
  ["OAuth", "runtime", false],
  ["OAuth", "missing", false],
  ["OAuth", "expired", false],
  ["OAuth", "unauthorized", false],
  ["OAuth", "network failure", false],
  ["OAuth", "empty usage", false],
  ["runtime", "OAuth", false],
])(
  "OpenAI %s uses separately authenticated Codex %s usage=%s",
  async (directSource, legacySource, expectedUsage) => {
    const queryFails = ["unauthorized", "network failure", "empty usage"].includes(legacySource);
    const handlers = new Map<string, (...args: unknown[]) => Promise<void>>();
    const setStatus = vi.fn();
    const fetchMock = vi.fn(async () => {
      if (legacySource === "unauthorized") return new Response(null, { status: 401 });
      if (legacySource === "network failure") throw new Error("offline");
      if (legacySource === "empty usage") return new Response("{}");
      return new Response(
        JSON.stringify({
          rate_limit: {
            primary_window: {
              used_percent: 12,
              limit_window_seconds: 18000,
              reset_after_seconds: 3600,
            },
          },
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    let stale = false;
    const getProviderAuth = vi.fn(async (provider: string) => {
      if (provider === "openai") {
        stale = true;
        return { source: directSource, auth: { apiKey: "direct-token" } };
      }
      expect(provider).toBe("openai-codex");
      if (legacySource === "expired") throw new Error("expired legacy token");
      if (legacySource === "missing") return undefined;
      return {
        source: queryFails ? "OAuth" : legacySource,
        auth: {
          apiKey: "legacy-token",
          headers: { "ChatGPT-Account-Id": "legacy-account" },
        },
      };
    });
    const registry = {
      getProviderAuth,
      getProvider: () => ({ auth: { oauth: { isSubscription: true } } }),
    };
    registerTokenCount({
      on: (event: string, handler: (...args: unknown[]) => Promise<void>) =>
        handlers.set(event, handler),
    } as never);
    await handlers.get("session_start")!(
      {},
      {
        model: { provider: "openai", id: "gpt-6.1-sol" },
        get modelRegistry() {
          if (stale) throw new Error("stale registry getter");
          return registry;
        },
        ui: { setStatus, theme: { fg: (_color: string, value: string) => value } },
      },
    );
    if (expectedUsage || queryFails) {
      expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
        "https://chatgpt.com/backend-api/wham/usage",
        expect.objectContaining({
          headers: {
            Authorization: "Bearer legacy-token",
            "ChatGPT-Account-Id": "legacy-account",
          },
        }),
      );
    } else {
      expect(fetchMock).not.toHaveBeenCalled();
    }
    expect(setStatus).toHaveBeenLastCalledWith(
      "token-count",
      expectedUsage
        ? "codex: 5h: 12% (1.0h)"
        : directSource === "OAuth"
          ? "openai: subscription usage unavailable; https://chatgpt.com/settings/usage"
          : undefined,
    );
    expect(getProviderAuth).toHaveBeenCalledTimes(directSource === "OAuth" ? 2 : 1);
  },
);

test.each(["openai-codex", "openai"])(
  "%s usage follows legacy OAuth account headers instead of reusing another account's cache",
  async (provider) => {
    const handlers = new Map<string, (...args: unknown[]) => Promise<void>>();
    let account = "account-a";
    const setStatus = vi.fn();
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            rate_limit: {
              primary_window: {
                used_percent: account === "account-a" ? 12 : 34,
                limit_window_seconds: 18000,
                reset_after_seconds: 3600,
              },
            },
          }),
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const auth = () => ({
      ok: true,
      source: "OAuth",
      auth: { apiKey: "same-token", headers: { "ChatGPT-Account-Id": account } },
    });
    const ctx = {
      model: { provider, id: "gpt-6.1-sol" },
      modelRegistry: {
        getProviderAuth: async (id: string) =>
          id === "openai" ? { source: "OAuth", auth: { apiKey: "direct-token" } } : auth(),
        getProvider: () => ({ auth: { oauth: { isSubscription: true } } }),
        getApiKeyAndHeaders: async () => ({ ok: true, ...auth().auth }),
      },
      ui: { setStatus, theme: { fg: (_color: string, value: string) => value } },
    };
    registerTokenCount({
      on: (event: string, handler: (...args: unknown[]) => Promise<void>) =>
        handlers.set(event, handler),
    } as never);
    await handlers.get("session_start")!({}, ctx);
    expect(setStatus).toHaveBeenLastCalledWith("token-count", "codex: 5h: 12% (1.0h)");
    account = "account-b";
    await handlers.get("turn_end")!({}, ctx);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(setStatus).toHaveBeenLastCalledWith("token-count", "codex: 5h: 34% (1.0h)");
  },
);

test.each(["stored", "env", undefined])(
  "legacy usage rejects non-OAuth auth source %s",
  async (source) => {
    const handlers = new Map<string, (...args: unknown[]) => Promise<void>>();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ rate_limit: {} })));
    vi.stubGlobal("fetch", fetchMock);
    registerTokenCount({
      on: (event: string, handler: (...args: unknown[]) => Promise<void>) =>
        handlers.set(event, handler),
    } as never);
    const auth = { apiKey: "ordinary-api-key", headers: { "ChatGPT-Account-Id": "account" } };
    await handlers.get("session_start")!(
      {},
      {
        model: { provider: "openai-codex", id: "model" },
        modelRegistry: {
          getProviderAuth: async () => ({ source, auth }),
          getApiKeyAndHeaders: async () => ({ ok: true, ...auth }),
        },
        ui: { setStatus: vi.fn(), theme: { fg: (_color: string, value: string) => value } },
      },
    );
    expect(fetchMock).not.toHaveBeenCalled();
  },
);

test.each([undefined, "", "   "])(
  "legacy usage omits requests with invalid account metadata %s",
  async (accountId) => {
    const handlers = new Map<string, (...args: unknown[]) => Promise<void>>();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ rate_limit: {} })));
    vi.stubGlobal("fetch", fetchMock);
    registerTokenCount({
      on: (event: string, handler: (...args: unknown[]) => Promise<void>) =>
        handlers.set(event, handler),
    } as never);
    await handlers.get("session_start")!(
      {},
      {
        model: { provider: "openai-codex", id: "model" },
        modelRegistry: {
          getProviderAuth: async () => ({
            source: "OAuth",
            auth: { apiKey: "token", headers: { "ChatGPT-Account-Id": accountId } },
          }),
        },
        ui: { setStatus: vi.fn(), theme: { fg: (_color: string, value: string) => value } },
      },
    );
    expect(fetchMock).not.toHaveBeenCalled();
  },
);

test("a new session retires the previous session's pending usage even for the same account", async () => {
  const handlers = new Map<string, (...args: unknown[]) => Promise<void>>();
  const completions: Array<() => void> = [];
  const query = vi.fn(
    () =>
      new Promise<ReturnType<typeof normalizeCopilotUsage>>((resolve) =>
        completions.push(() => resolve(normalizeCopilotUsage(tokenBillingPayload, NOW))),
      ),
  );
  const setStatus = vi.fn();
  const ctx = {
    model: { provider: "github-copilot", id: "model" },
    ui: { setStatus, theme: { fg: (_color: string, value: string) => value } },
  };
  registerTokenCount(
    {
      on: (event: string, handler: (...args: unknown[]) => Promise<void>) =>
        handlers.set(event, handler),
    } as never,
    {
      resolveSource: () => ({ provider: "github-copilot", key: "account", query }),
      now: () => NOW,
    },
  );
  const old = handlers.get("session_start")!({}, ctx);
  const current = handlers.get("session_start")!({}, ctx);
  expect(query).toHaveBeenCalledTimes(2);
  completions[0]!();
  await old;
  expect(setStatus).toHaveBeenLastCalledWith("token-count", undefined);
  completions[1]!();
  await current;
  expect(setStatus).toHaveBeenLastCalledWith(
    "token-count",
    "copilot: 412/1,000 credits (59% left, 26d)",
  );
});

test("expired legacy auth clears usage without querying or rejecting the lifecycle event", async () => {
  const handlers = new Map<string, (...args: unknown[]) => Promise<void>>();
  const fetchMock = vi.fn();
  const setStatus = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  registerTokenCount({
    on: (event: string, handler: (...args: unknown[]) => Promise<void>) =>
      handlers.set(event, handler),
  } as never);
  await expect(
    handlers.get("session_start")!(
      {},
      {
        model: { provider: "openai-codex", id: "model" },
        modelRegistry: {
          getProviderAuth: async () => {
            throw new Error("expired refresh token");
          },
        },
        ui: { setStatus, theme: { fg: (_color: string, value: string) => value } },
      },
    ),
  ).resolves.toBeUndefined();
  expect(fetchMock).not.toHaveBeenCalled();
  expect(setStatus).toHaveBeenLastCalledWith("token-count", undefined);
});

test("stock legacy OAuth without headers uses the token's ChatGPT account claim", async () => {
  const handlers = new Map<string, (...args: unknown[]) => Promise<void>>();
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ rate_limit: {} })));
  vi.stubGlobal("fetch", fetchMock);
  const token = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "stock-account" } })).toString("base64url")}.signature`;
  registerTokenCount({
    on: (event: string, handler: (...args: unknown[]) => Promise<void>) =>
      handlers.set(event, handler),
  } as never);
  await handlers.get("session_start")!(
    {},
    {
      model: { provider: "openai-codex", id: "gpt-6.1-sol" },
      modelRegistry: {
        getProviderAuth: async () => ({ source: "OAuth", auth: { apiKey: token } }),
      },
      ui: { setStatus: vi.fn(), theme: { fg: (_color: string, value: string) => value } },
    },
  );
  expect(fetchMock).toHaveBeenCalledWith(
    "https://chatgpt.com/backend-api/wham/usage",
    expect.objectContaining({
      headers: { Authorization: `Bearer ${token}`, "chatgpt-account-id": "stock-account" },
    }),
  );
});

test.each([undefined, "", "   ", 42])(
  "stock legacy OAuth omits invalid JWT account claim %s",
  async (accountId) => {
    const handlers = new Map<string, (...args: unknown[]) => Promise<void>>();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const token = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } })).toString("base64url")}.signature`;
    registerTokenCount({
      on: (event: string, handler: (...args: unknown[]) => Promise<void>) =>
        handlers.set(event, handler),
    } as never);
    await handlers.get("session_start")!(
      {},
      {
        model: { provider: "openai-codex", id: "model" },
        modelRegistry: {
          getProviderAuth: async () => ({ source: "OAuth", auth: { apiKey: token } }),
        },
        ui: { setStatus: vi.fn(), theme: { fg: (_color: string, value: string) => value } },
      },
    );
    expect(fetchMock).not.toHaveBeenCalled();
  },
);

test("the usage resolution seam can display an unavailable status without registry access", async () => {
  const handlers = new Map<string, (...args: unknown[]) => Promise<void>>();
  const setStatus = vi.fn();
  registerTokenCount(
    {
      on: (event: string, handler: (...args: unknown[]) => Promise<void>) =>
        handlers.set(event, handler),
    } as never,
    { resolveSource: () => ({ status: "subscription usage unavailable" }) },
  );
  await handlers.get("session_start")!(
    {},
    {
      model: { provider: "openai", id: "model" },
      get modelRegistry() {
        throw new Error("resolution owns registry access");
      },
      ui: { setStatus, theme: { fg: (_color: string, value: string) => value } },
    },
  );
  expect(setStatus).toHaveBeenLastCalledWith("token-count", "subscription usage unavailable");
});
