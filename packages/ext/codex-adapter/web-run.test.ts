import { Buffer } from "node:buffer";
import { createServer } from "node:http";
import { Value } from "typebox/value";
import { describe, expect, test, vi } from "vitest";

import { getBundledWebRunPath } from "./web-run/binary.js";
import {
  createWebRunTool,
  isWebRunAvailable,
  registerWebRunTool,
  type WebRunNativeInput,
} from "./web-run/tool.js";

function jwt(accountId: string): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
  })}.signature`;
}

const model = (provider: string, id: string, api: string, baseUrl: string) => ({
  provider,
  id,
  api,
  baseUrl,
});

function context(options: {
  active: ReturnType<typeof model>;
  models?: ReturnType<typeof model>[];
  source?: string;
  auth?: { ok: true; apiKey?: string; headers?: Record<string, string | null>; baseUrl?: string };
}) {
  return {
    get model() {
      return options.active;
    },
    get modelRegistry() {
      return {
        getAll: () => options.models ?? [options.active],
        getProviderAuth: vi.fn(async () =>
          options.auth ? { auth: options.auth, source: options.source ?? "OAuth" } : undefined,
        ),
        getApiKeyAndHeaders: vi.fn(
          async () => options.auth ?? { ok: false, error: "not logged in" },
        ),
      };
    },
  };
}

describe("web_run route policy", () => {
  test("bundles Linux x64 and arm64 clients", () => {
    expect(getBundledWebRunPath("linux", "x64")).toBeDefined();
    expect(getBundledWebRunPath("linux", "arm64")).toBeDefined();
    expect(getBundledWebRunPath("darwin", "arm64")).toBeUndefined();
  });

  test("trusts only stock Codex Responses and explicit compatible providers", () => {
    expect(
      isWebRunAvailable(model("openai-codex", "gpt", "openai-codex-responses", "https://x"), {}),
    ).toBe(true);
    expect(
      isWebRunAvailable(model("openai-codex", "gpt", "openai-completions", "https://x"), {}),
    ).toBe(false);
    expect(
      isWebRunAvailable(model("looks-like-codex", "gpt", "openai-responses", "https://x"), {}),
    ).toBe(false);
    expect(
      isWebRunAvailable(model("trusted", "gpt", "openai-responses", "https://proxy.example/v1"), {
        webSearchProviders: [" TRUSTED "],
      }),
    ).toBe(true);
    expect(
      isWebRunAvailable(model("bedrock", "claude", "bedrock-converse-stream", "https://x"), {
        allowOpenAICodexFallback: true,
      }),
    ).toBe(true);
    expect(isWebRunAvailable(undefined, { allowOpenAICodexFallback: true })).toBe(false);
  });

  test("rejects fractional values that the native integer protocol cannot decode", () => {
    const schema = createWebRunTool({ getConfig: () => ({}) }).parameters;
    expect(Value.Check(schema, { click: [{ ref_id: "turn0view0", id: 1 }] })).toBe(true);
    expect(Value.Check(schema, { click: [{ ref_id: "turn0view0", id: 1.5 }] })).toBe(false);
    expect(Value.Check(schema, { open: [{ ref_id: "turn0view0", lineno: 2.5 }] })).toBe(false);
    expect(Value.Check(schema, { search_query: [{ q: "q", recency: 0.5 }] })).toBe(false);
  });
});

describe("web_run execution", () => {
  test.each(["subscription-token", "sk-api-key"])(
    "direct OpenAI auth %s cannot opt into the legacy search protocol",
    async (apiKey) => {
      const active = model(
        "openai",
        "gpt-6.1-sol",
        "openai-responses",
        "https://api.openai.com/v1",
      );
      const runNative = vi.fn();
      const config = { webSearchProviders: ["openai"] };
      const tool = createWebRunTool({ getConfig: () => config, runNative });
      expect(isWebRunAvailable(active, config)).toBe(false);
      await expect(
        tool.execute(
          "direct",
          { search_query: [{ q: "q" }] },
          undefined,
          undefined,
          context({ active, auth: { ok: true, apiKey } }) as never,
        ),
      ).rejects.toThrow("OpenAI ChatGPT login and API keys do not have a verified web_run route");
      expect(runNative).not.toHaveBeenCalled();
    },
  );

  test("legacy search rejects API-key auth even with plausible account claims", async () => {
    const runNative = vi.fn();
    const tool = createWebRunTool({ getConfig: () => ({}), runNative });
    const active = model(
      "openai-codex",
      "gpt-6.1-sol",
      "openai-codex-responses",
      "https://chatgpt.com/backend-api",
    );
    await expect(
      tool.execute(
        "key",
        { search_query: [{ q: "q" }] },
        undefined,
        undefined,
        context({ active, source: "stored", auth: { ok: true, apiKey: jwt("account") } }) as never,
      ),
    ).rejects.toThrow('requires legacy OAuth; run "/login openai-codex"');
    expect(runNative).not.toHaveBeenCalled();
  });

  test.each(["", "   "])("legacy search rejects blank account metadata %s", async (accountId) => {
    const runNative = vi.fn();
    const tool = createWebRunTool({ getConfig: () => ({}), runNative });
    const active = model(
      "openai-codex",
      "gpt-6.1-sol",
      "openai-codex-responses",
      "https://chatgpt.com/backend-api",
    );
    await expect(
      tool.execute(
        "invalid",
        { search_query: [{ q: "q" }] },
        undefined,
        undefined,
        context({
          active,
          auth: { ok: true, apiKey: jwt("account"), headers: { "chatgpt-account-id": accountId } },
        }) as never,
      ),
    ).rejects.toThrow("missing a valid ChatGPT account ID");
    expect(runNative).not.toHaveBeenCalled();
  });

  test("legacy search uses resolved OAuth identity rather than stale model auth headers", async () => {
    const runNative = vi.fn(async (_input: WebRunNativeInput) => JSON.stringify({ output: "ok" }));
    const tool = createWebRunTool({ getConfig: () => ({}), runNative });
    const active = {
      ...model(
        "openai-codex",
        "gpt-6.1-sol",
        "openai-codex-responses",
        "https://chatgpt.com/backend-api",
      ),
      headers: {
        Authorization: "Bearer stale-key",
        "chatgpt-account-id": "stale-account",
        "x-static": "keep",
      },
    };
    await tool.execute(
      "oauth",
      { search_query: [{ q: "q" }] },
      undefined,
      undefined,
      context({ active, auth: { ok: true, apiKey: jwt("selected") } }) as never,
    );
    expect(runNative.mock.calls[0]![0].headers).toMatchObject({
      Authorization: `Bearer ${jwt("selected")}`,
      "chatgpt-account-id": "selected",
      "x-static": "keep",
    });
  });

  test("bundled client posts only the bounded structured request to the selected route", async () => {
    let captured:
      | { headers: Record<string, string | string[] | undefined>; body: unknown }
      | undefined;
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        captured = { headers: request.headers, body: JSON.parse(body) };
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ output: "native result", results: [{ ref_id: "turn0search0" }] }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("missing test server address");
      const active = model(
        "trusted",
        "search-model",
        "openai-responses",
        `http://127.0.0.1:${address.port}/v1`,
      );
      const tool = createWebRunTool({
        getConfig: () => ({ webSearchProviders: ["trusted"] }),
      });
      const result = await tool.execute(
        "call",
        { image_query: [{ q: "red panda" }], response_length: "short" },
        undefined,
        undefined,
        {
          ...context({
            active,
            auth: { ok: true, apiKey: "registry-key", headers: { Authorization: "Custom key" } },
          }),
          getSystemPrompt: () => "DO NOT SEND THIS PROMPT",
          sessionManager: { buildContextEntries: () => ["DO NOT SEND THIS HISTORY"] },
        } as never,
      );

      expect(result.content).toEqual([{ type: "text", text: "native result" }]);
      expect(captured?.headers.authorization).toBe("Custom key");
      expect(captured?.body).toMatchObject({
        model: "search-model",
        commands: { image_query: [{ q: "red panda" }], response_length: "short" },
        settings: { allowed_callers: ["direct"], external_web_access: true },
        max_output_tokens: 8000,
      });
      const transmitted = JSON.stringify(captured?.body);
      expect(transmitted).not.toContain("DO NOT SEND");
      expect(captured?.body).not.toHaveProperty("input");
    } finally {
      server.close();
      server.closeAllConnections();
    }
  });

  test("cancels an in-flight bundled HTTP request", async () => {
    let sawRequest!: () => void;
    const requested = new Promise<void>((resolve) => {
      sawRequest = resolve;
    });
    const server = createServer(() => sawRequest());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("missing test server address");
      const active = model(
        "trusted",
        "search-model",
        "openai-responses",
        `http://127.0.0.1:${address.port}`,
      );
      const tool = createWebRunTool({
        getConfig: () => ({ webSearchProviders: ["trusted"] }),
      });
      const controller = new AbortController();
      const execution = tool.execute(
        "call",
        { search_query: [{ q: "wait" }] },
        controller.signal,
        undefined,
        context({
          active,
          auth: { ok: true, headers: { Authorization: "Custom key" } },
        }) as never,
      );
      await requested;
      controller.abort();
      await expect(execution).rejects.toThrow("allowlisted trusted route failed: cancelled");
    } finally {
      server.close();
      server.closeAllConnections();
    }
  });

  test("bounds bundled responses and reports native HTTP failures on the selected route", async () => {
    let mode: "http" | "oversized" = "http";
    const server = createServer((_request, response) => {
      if (mode === "http") {
        response.writeHead(503, { "content-type": "text/plain" });
        response.end("temporarily unavailable");
      } else {
        response.writeHead(200, {
          "content-type": "application/json",
          "content-length": String(7 * 1024 * 1024),
        });
        response.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("missing test server address");
      const active = model(
        "trusted",
        "search-model",
        "openai-responses",
        `http://127.0.0.1:${address.port}`,
      );
      const tool = createWebRunTool({
        getConfig: () => ({ webSearchProviders: ["trusted"] }),
      });
      const ctx = context({
        active,
        auth: { ok: true, headers: { Authorization: "Custom key" } },
      }) as never;

      await expect(
        tool.execute("http", { search_query: [{ q: "q" }] }, undefined, undefined, ctx),
      ).rejects.toThrow("allowlisted trusted route failed: Error: web_run search failed");
      mode = "oversized";
      await expect(
        tool.execute("large", { search_query: [{ q: "q" }] }, undefined, undefined, ctx),
      ).rejects.toThrow("web_run search response exceeded 6291456 bytes");
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  test("uses stock registry auth and sends no Pi conversation context", async () => {
    const inputs: WebRunNativeInput[] = [];
    const runNative = vi.fn(async (input: WebRunNativeInput) => {
      inputs.push(input);
      return JSON.stringify({
        output_text: "result",
        search_results: [{ ref_id: "turn0search0" }],
      });
    });
    const tool = createWebRunTool({ getConfig: () => ({}), runNative });
    const ctx = context({
      active: model(
        "openai-codex",
        "gpt-5.3-codex",
        "openai-codex-responses",
        "https://chatgpt.com/backend-api",
      ),
      auth: { ok: true, apiKey: jwt("account-1"), headers: { "x-stock": "header" } },
    });

    const result = await tool.execute(
      "call-1",
      { search_query: [{ q: "current news" }], response_length: "short" },
      undefined,
      undefined,
      {
        ...ctx,
        sessionManager: {
          buildContextEntries: () => [
            { type: "message", message: { role: "user", content: "SECRET" } },
          ],
        },
        getSystemPrompt: () => "SECRET SYSTEM PROMPT",
        cwd: "/secret/project",
      } as never,
    );

    expect(result.content).toEqual([{ type: "text", text: "result" }]);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.url).toBe("https://chatgpt.com/backend-api/codex/alpha/search");
    expect(inputs[0]?.headers).toMatchObject({
      Authorization: expect.stringMatching(/^Bearer /),
      "chatgpt-account-id": "account-1",
      "x-stock": "header",
    });
    expect(inputs[0]?.params).toMatchObject({
      search_query: [{ q: "current news" }],
      response_length: "short",
      model: "gpt-5.3-codex",
    });
    expect(JSON.stringify(inputs[0]?.params)).not.toContain("SECRET");
    expect(inputs[0]?.params).not.toHaveProperty("input");
    expect(inputs[0]?.params).not.toHaveProperty("cwd");
  });

  test.each(["bedrock", "openai"])(
    "explicit fallback from %s resolves only legacy auth without changing the active model",
    async (provider) => {
      const runNative = vi.fn(async (_input: WebRunNativeInput) =>
        JSON.stringify({ output: "fallback result" }),
      );
      const active = model(
        provider,
        "gpt-6.1-sol",
        provider === "openai" ? "openai-responses" : "bedrock-converse-stream",
        "https://active.example",
      );
      const codex = model(
        "openai-codex",
        "gpt-5.3-codex",
        "openai-codex-responses",
        "https://chatgpt.com/backend-api",
      );
      const ctx = context({
        active,
        models: [active, codex],
        auth: { ok: true, apiKey: jwt("fallback-account") },
      });
      const registry = ctx.modelRegistry;
      const tool = createWebRunTool({
        getConfig: () => ({ allowOpenAICodexFallback: true }),
        runNative,
      });

      await tool.execute(
        "call-1",
        { open: [{ ref_id: "https://example.com" }] },
        undefined,
        undefined,
        { model: active, modelRegistry: registry } as never,
      );

      expect(registry.getProviderAuth).toHaveBeenCalledExactlyOnceWith("openai-codex");
      expect(registry.getApiKeyAndHeaders).not.toHaveBeenCalled();
      expect(ctx.model).toBe(active);
      expect(runNative.mock.calls[0]?.[0]).toMatchObject({
        route: "OpenAI Codex fallback",
        params: { model: "gpt-5.3-codex", open: [{ ref_id: "https://example.com" }] },
      });
    },
  );

  test("allowlisted provider uses its own endpoint and never retries through fallback", async () => {
    const runNative = vi.fn(async (_input: WebRunNativeInput) => {
      throw new Error("HTTP 503 unavailable");
    });
    const active = model("trusted", "gpt", "openai-responses", "https://proxy.example/v1");
    const tool = createWebRunTool({
      getConfig: () => ({
        webSearchProviders: ["trusted"],
        allowOpenAICodexFallback: true,
      }),
      runNative,
    });

    await expect(
      tool.execute(
        "call-1",
        { find: [{ ref_id: "turn0fetch0", pattern: "needle" }] },
        undefined,
        undefined,
        context({
          active,
          auth: { ok: true, apiKey: "proxy-key", headers: { Authorization: "Bearer proxy-key" } },
        }) as never,
      ),
    ).rejects.toThrow("allowlisted trusted route failed: HTTP 503 unavailable");
    expect(runNative).toHaveBeenCalledOnce();
    expect(runNative.mock.calls[0]?.[0]).toMatchObject({
      url: "https://proxy.example/v1/alpha/search",
      route: "allowlisted trusted",
    });
  });

  test("preserves compatible-provider headers without inventing Bearer authentication", async () => {
    const runNative = vi.fn(async (_input: WebRunNativeInput) => JSON.stringify({ output: "ok" }));
    const active = Object.assign(
      model("trusted", "gpt", "openai-responses", "https://proxy.example/v1"),
      { headers: { Authorization: "stale", "x-static": "yes" } },
    );
    const tool = createWebRunTool({
      getConfig: () => ({ webSearchProviders: ["trusted"] }),
      runNative,
    });
    await tool.execute(
      "call",
      { search_query: [{ q: "q" }] },
      undefined,
      undefined,
      context({
        active,
        auth: {
          ok: true,
          apiKey: "must-not-become-bearer",
          headers: { Authorization: null, "x-provider-key": "registry-key" },
        },
      }) as never,
    );

    expect(runNative.mock.calls[0]?.[0].headers).toMatchObject({
      "x-static": "yes",
      "x-provider-key": "registry-key",
    });
    expect(runNative.mock.calls[0]?.[0].headers).not.toHaveProperty("Authorization");
    expect(runNative.mock.calls[0]?.[0].headers).not.toHaveProperty("authorization");
  });

  test("reports route-specific auth, API-shape, cancellation, and empty-output errors", async () => {
    const codex = model(
      "openai-codex",
      "gpt",
      "openai-codex-responses",
      "https://chatgpt.com/backend-api",
    );
    const missing = createWebRunTool({ getConfig: () => ({}), runNative: vi.fn() });
    await expect(
      missing.execute(
        "call",
        { image_query: [{ q: "cats" }] },
        undefined,
        undefined,
        context({ active: codex }) as never,
      ),
    ).rejects.toThrow(
      'stock openai-codex route authentication failed: not logged in; run "/login openai-codex"',
    );

    const invalidAccount = createWebRunTool({ getConfig: () => ({}), runNative: vi.fn() });
    await expect(
      invalidAccount.execute(
        "call",
        { click: [{ ref_id: "turn0fetch0", id: 1 }] },
        undefined,
        undefined,
        context({ active: codex, auth: { ok: true, apiKey: "not-a-jwt" } }) as never,
      ),
    ).rejects.toThrow(
      "stock openai-codex route authentication is missing a valid ChatGPT account ID",
    );

    const unsupported = createWebRunTool({
      getConfig: () => ({ webSearchProviders: ["trusted"] }),
      runNative: vi.fn(),
    });
    await expect(
      unsupported.execute(
        "call",
        { search_query: [{ q: "q" }] },
        undefined,
        undefined,
        context({ active: model("trusted", "gpt", "openai-completions", "https://x") }) as never,
      ),
    ).rejects.toThrow("allowlisted trusted route requires a Responses API model");

    const controller = new AbortController();
    controller.abort();
    const cancelled = createWebRunTool({ getConfig: () => ({}), runNative: vi.fn() });
    await expect(
      cancelled.execute(
        "call",
        { search_query: [{ q: "q" }] },
        controller.signal,
        undefined,
        context({ active: codex, auth: { ok: true, apiKey: jwt("account") } }) as never,
      ),
    ).rejects.toThrow("stock openai-codex route cancelled");

    const empty = createWebRunTool({
      getConfig: () => ({}),
      runNative: vi.fn(async () => JSON.stringify({ search_results: [] })),
    });
    await expect(
      empty.execute(
        "call",
        { search_query: [{ q: "q" }] },
        undefined,
        undefined,
        context({ active: codex, auth: { ok: true, apiKey: jwt("account") } }) as never,
      ),
    ).rejects.toThrow("stock openai-codex route failed: returned no output");
  });

  test("reports a missing native executable on the selected route with recovery guidance", async () => {
    const codex = model(
      "openai-codex",
      "gpt",
      "openai-codex-responses",
      "https://chatgpt.com/backend-api",
    );
    const tool = createWebRunTool({
      getConfig: () => ({}),
      binaryPath: "/definitely/missing/pi-bites-web-run",
    });
    await expect(
      tool.execute(
        "call",
        { search_query: [{ q: "q" }] },
        undefined,
        undefined,
        context({ active: codex, auth: { ok: true, apiKey: jwt("account") } }) as never,
      ),
    ).rejects.toThrow(
      /stock openai-codex route failed: web_run native executable is not available.*Rebuild it.*no other provider was tried/su,
    );
  });

  test("snapshots ctx before registry and native continuations", async () => {
    let stale = false;
    let resolveAuth!: (value: { ok: true; apiKey: string }) => void;
    const auth = new Promise<{ ok: true; apiKey: string }>((resolve) => {
      resolveAuth = resolve;
    });
    const active = model(
      "openai-codex",
      "gpt",
      "openai-codex-responses",
      "https://chatgpt.com/backend-api",
    );
    const ctx = {
      get model() {
        if (stale) throw new Error("stale model");
        return active;
      },
      get modelRegistry() {
        if (stale) throw new Error("stale registry");
        return {
          getAll: () => [active],
          getProviderAuth: async () => ({ auth: await auth, source: "OAuth" }),
        };
      },
    };
    const tool = createWebRunTool({
      getConfig: () => ({}),
      runNative: vi.fn(async () => JSON.stringify({ output_text: "ok" })),
    });
    const execution = tool.execute(
      "call",
      { search_query: [{ q: "q" }] },
      undefined,
      undefined,
      ctx as never,
    );
    stale = true;
    resolveAuth({ ok: true, apiKey: jwt("account") });
    await expect(execution).resolves.toMatchObject({ content: [{ text: "ok" }] });
  });

  test("navigation batching preserves pending results and account citations across rollover", async () => {
    const pending = Promise.withResolvers<string>();
    const runNative = vi
      .fn(async (_input: WebRunNativeInput) => JSON.stringify({ output: "fresh" }))
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValueOnce(
        JSON.stringify({
          output: "fresh",
          results: [{ ref_id: "fresh-ref", url: "https://fresh.example" }],
        }),
      );
    const tool = createWebRunTool({ getConfig: () => ({}), runNative });
    const active = model(
      "openai-codex",
      "gpt-6.1-sol",
      "openai-codex-responses",
      "https://chatgpt.com/backend-api",
    );
    const ctx = context({ active, auth: { ok: true, apiKey: jwt("account") } }) as never;
    const call = () =>
      tool.execute("call", { search_query: [{ q: "q" }] }, undefined, undefined, ctx);
    const old = call();
    await vi.waitFor(() => expect(runNative).toHaveBeenCalledOnce());
    for (let i = 0; i < 32; i++) await call();
    expect(runNative.mock.calls[0]![0].params.id).not.toBe(runNative.mock.calls[32]![0].params.id);
    pending.resolve(
      JSON.stringify({
        output: "old",
        results: [{ ref_id: "old-ref", url: "https://old.example" }],
      }),
    );
    await expect(old).resolves.toMatchObject({ content: [{ text: "old" }] });
    expect(tool.transformCitations("citeold-reffresh-ref")).toContain("old.example");
    expect(tool.transformCitations("citeold-reffresh-ref")).toContain("fresh.example");
  });

  test.each(["old", "new"])(
    "delayed authentication for %s cannot restore a superseded account",
    async (account) => {
      const pending = Promise.withResolvers<{ source: string; auth: { apiKey: string } }>();
      const runNative = vi.fn(async (_input: WebRunNativeInput) =>
        JSON.stringify({ output: "ok" }),
      );
      const tool = createWebRunTool({ getConfig: () => ({}), runNative });
      const active = model(
        "openai-codex",
        "gpt-6.1-sol",
        "openai-codex-responses",
        "https://chatgpt.com/backend-api",
      );
      const ctx = {
        model: active,
        modelRegistry: {
          getAll: () => [active],
          getProviderAuth: vi
            .fn(async () => ({ source: "OAuth", auth: { apiKey: jwt("new") } }))
            .mockImplementationOnce(() => pending.promise),
        },
      } as never;
      const call = () =>
        tool.execute("call", { search_query: [{ q: "q" }] }, undefined, undefined, ctx);
      const delayed = call();
      await call();
      pending.resolve({ source: "OAuth", auth: { apiKey: jwt(account) } });
      if (account === "old") {
        await expect(delayed).rejects.toThrow("search context changed");
        expect(runNative).toHaveBeenCalledOnce();
      } else {
        await expect(delayed).resolves.toMatchObject({ content: [{ text: "ok" }] });
        expect(runNative).toHaveBeenCalledTimes(2);
        expect(runNative.mock.calls[1]![0].params.id).toBe(runNative.mock.calls[0]![0].params.id);
      }
      expect(
        runNative.mock.calls.every(([input]) => input.headers["chatgpt-account-id"] === "new"),
      ).toBe(true);
    },
  );

  test("account switches rotate navigation and retire old search completions", async () => {
    const pending = Promise.withResolvers<string>();
    const runNative = vi
      .fn(async (_input: WebRunNativeInput) => JSON.stringify({ output: "fresh" }))
      .mockImplementationOnce(() => pending.promise);
    const tool = createWebRunTool({ getConfig: () => ({}), runNative });
    const active = model(
      "openai-codex",
      "gpt-6.1-sol",
      "openai-codex-responses",
      "https://chatgpt.com/backend-api",
    );
    const call = (account: string) =>
      tool.execute(
        "call",
        { search_query: [{ q: "q" }] },
        undefined,
        undefined,
        context({ active, auth: { ok: true, apiKey: jwt(account) } }) as never,
      );
    const old = call("old");
    await vi.waitFor(() => expect(runNative).toHaveBeenCalledOnce());
    await call("new");
    expect(runNative.mock.calls[0]![0].params.id).not.toBe(runNative.mock.calls[1]![0].params.id);
    pending.resolve(
      JSON.stringify({
        output: "old",
        results: [{ ref_id: "old-ref", url: "https://old.example" }],
      }),
    );
    await expect(old).rejects.toThrow("search context changed");
    expect(tool.transformCitations("citeold-ref")).not.toContain("old.example");
  });

  test("session replacement retires pending auth even with throwing stale context getters", async () => {
    const pending = Promise.withResolvers<{ ok: true; apiKey: string }>();
    const active = model(
      "openai-codex",
      "gpt-6.1-sol",
      "openai-codex-responses",
      "https://chatgpt.com/backend-api",
    );
    const runNative = vi.fn();
    const tool = createWebRunTool({ getConfig: () => ({}), runNative });
    let stale = false;
    const ctx = new Proxy(
      {
        model: active,
        modelRegistry: {
          getAll: () => [active],
          getProviderAuth: async () => ({ auth: await pending.promise, source: "OAuth" }),
        },
      },
      {
        get(target, key) {
          if (stale) throw new Error("stale ctx");
          return Reflect.get(target, key);
        },
      },
    );
    const execution = tool.execute(
      "old",
      { search_query: [{ q: "q" }] },
      undefined,
      undefined,
      ctx as never,
    );
    stale = true;
    tool.resetNavigationState();
    pending.resolve({ ok: true, apiKey: jwt("account") });
    await expect(execution).rejects.toThrow("search context changed");
    expect(runNative).not.toHaveBeenCalled();
  });

  test.each(["session_start", "model_select"])(
    "rotates tool-owned navigation state on %s",
    async (eventName) => {
      let registered!: ReturnType<typeof createWebRunTool>;
      let onSessionStart!: () => void;
      const runNative = vi.fn(async (_input: WebRunNativeInput) =>
        JSON.stringify({ output: "ok" }),
      );
      registerWebRunTool(
        {
          registerTool: (tool: unknown) => {
            registered = tool as typeof registered;
          },
          registerMarkdownTransformer: vi.fn(),
          on: (event: string, handler: () => void) => {
            if (event === eventName) onSessionStart = handler;
          },
        } as never,
        { getConfig: () => ({}), runNative },
      );
      const codex = model(
        "openai-codex",
        "gpt",
        "openai-codex-responses",
        "https://chatgpt.com/backend-api",
      );
      const ctx = context({ active: codex, auth: { ok: true, apiKey: jwt("account") } }) as never;

      await registered.execute(
        "first",
        { search_query: [{ q: "one" }] },
        undefined,
        undefined,
        ctx,
      );
      const firstId = runNative.mock.calls[0]?.[0].params.id;
      onSessionStart();
      await registered.execute(
        "second",
        { open: [{ ref_id: "turn0search0" }] },
        undefined,
        undefined,
        ctx,
      );
      expect(runNative.mock.calls[1]?.[0].params.id).not.toBe(firstId);
    },
  );
});

describe("web_run rendering", () => {
  const theme = {
    bold: (text: string) => `<bold>${text}</bold>`,
    fg: (role: string, text: string) => `<${role}>${text}</${role}>`,
    bg: (_role: string, text: string) => text,
  };

  test("renders one semantic collapsed row without exposing navigation IDs", () => {
    const tool = createWebRunTool({ getConfig: () => ({}) });
    const context = {
      state: {},
      isPartial: false,
      isError: false,
    } as never;
    const call = tool.renderCall!({ open: [{ ref_id: "turn0search4" }] }, theme as never, context);
    const result = tool.renderResult!(
      {
        content: [{ type: "text", text: "result body" }],
        details: { route: "stock", webRun: {} },
      },
      { expanded: false, isPartial: false },
      theme as never,
      context,
    );

    expect(tool.renderShell).toBe("self");
    expect([...call.render(200), ...result.render(200)].map((line) => line.trimEnd())).toEqual([
      "",
      "<bold>Web</bold><accent> Open search result</accent>",
      "",
    ]);
  });

  test("uses action summaries and reserves a blank line for expanded details", () => {
    const tool = createWebRunTool({ getConfig: () => ({}) });
    const context = {
      state: {},
      isPartial: false,
      isError: false,
    } as never;
    const call = tool.renderCall!(
      { search_query: [{ q: "TypeScript official handbook" }] },
      theme as never,
      context,
    );
    const result = tool.renderResult!(
      {
        content: [{ type: "text", text: "first\nsecond" }],
        details: { route: "stock", webRun: {} },
      },
      { expanded: true, isPartial: false },
      theme as never,
      context,
    );

    expect([...call.render(200), ...result.render(200)].map((line) => line.trimEnd())).toEqual([
      "",
      "<bold>Web</bold><accent> Search TypeScript official handbook</accent>",
      "",
      "<dim>first</dim>",
      "<dim>second</dim>",
      "",
    ]);
  });

  test("includes every operation in a multi-operation call summary", () => {
    const tool = createWebRunTool({ getConfig: () => ({}) });
    const call = tool.renderCall!(
      {
        search_query: [{ q: "docs" }],
        image_query: [{ q: "cats" }],
        open: [{ ref_id: "turn0view0" }],
        click: [{ ref_id: "turn0view0", id: 2 }],
        find: [{ ref_id: "turn0view0", pattern: "needle" }],
      },
      theme as never,
      { state: {}, isPartial: false, isError: false } as never,
    );

    expect(call.render(200).join("\n")).toContain(
      "Search docs · Images cats · Open page · Click link 2 · Find needle",
    );
  });

  test("renders web citation markers as links instead of internal protocol syntax", async () => {
    let transform!: (markdown: string, context: { messageType: string }) => string;
    let registered!: ReturnType<typeof createWebRunTool>;
    registerWebRunTool(
      {
        registerTool: (tool: typeof registered) => {
          registered = tool;
        },
        registerMarkdownTransformer: (transformer: typeof transform) => {
          transform = transformer;
        },
        on: vi.fn(),
      } as never,
      {
        getConfig: () => ({ webSearchProviders: ["work"] }),
        runNative: async () =>
          JSON.stringify({
            output: "result",
            search_results: [
              { ref_id: "turn0search0", url: "https://www.typescriptlang.org/docs/handbook/intro" },
            ],
          }),
      },
    );
    await registered.execute(
      "citation",
      { search_query: [{ q: "typescript" }] },
      undefined,
      undefined,
      context({
        active: model("work", "gpt", "openai-responses", "https://work.example"),
        auth: { ok: true, headers: { Authorization: "Bearer work" } },
      }) as never,
    );

    expect(transform("Typed JavaScript. citeturn0search0", { messageType: "assistant" })).toBe(
      "Typed JavaScript. [source](<https://www.typescriptlang.org/docs/handbook/intro>)",
    );
    expect(transform("Unknown. citeturn9view9", { messageType: "assistant" })).toBe(
      "Unknown. [web source]",
    );
    expect(transform("citeturn0search0", { messageType: "user" })).toBe("citeturn0search0");
  });
});
