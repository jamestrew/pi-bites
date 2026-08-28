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
  auth?: { ok: true; apiKey?: string; headers?: Record<string, string | null>; baseUrl?: string };
}) {
  return {
    get model() {
      return options.active;
    },
    get modelRegistry() {
      return {
        getAll: () => options.models ?? [options.active],
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

  test("explicit fallback resolves a stock Codex model without changing the active model", async () => {
    const runNative = vi.fn(async (_input: WebRunNativeInput) =>
      JSON.stringify({ output: "fallback result" }),
    );
    const active = model("bedrock", "claude", "bedrock-converse-stream", "https://bedrock");
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
    const tool = createWebRunTool({
      getConfig: () => ({ allowOpenAICodexFallback: true }),
      runNative,
    });

    await tool.execute(
      "call-1",
      { open: [{ ref_id: "https://example.com" }] },
      undefined,
      undefined,
      ctx as never,
    );

    expect(ctx.model).toBe(active);
    expect(runNative.mock.calls[0]?.[0]).toMatchObject({
      route: "OpenAI Codex fallback",
      params: { model: "gpt-5.3-codex", open: [{ ref_id: "https://example.com" }] },
    });
  });

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
        return { getAll: () => [active], getApiKeyAndHeaders: () => auth };
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

  test("rotates tool-owned navigation state when a new session starts", async () => {
    let registered!: ReturnType<typeof createWebRunTool>;
    let onSessionStart!: () => void;
    const runNative = vi.fn(async (_input: WebRunNativeInput) => JSON.stringify({ output: "ok" }));
    registerWebRunTool(
      {
        registerTool: (tool: unknown) => {
          registered = tool as typeof registered;
        },
        registerMarkdownTransformer: vi.fn(),
        on: (event: string, handler: () => void) => {
          if (event === "session_start") onSessionStart = handler;
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

    await registered.execute("first", { search_query: [{ q: "one" }] }, undefined, undefined, ctx);
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
  });
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

  test("renders web citation markers as links instead of internal protocol syntax", async () => {
    let transform!: (markdown: string, context: { messageType: string }) => string;
    let recordResult!: (event: { toolName: string; details: unknown }) => void;
    registerWebRunTool(
      {
        registerTool: vi.fn(),
        registerMarkdownTransformer: (transformer: typeof transform) => {
          transform = transformer;
        },
        on: (event: string, handler: typeof recordResult) => {
          if (event === "tool_result") recordResult = handler;
        },
      } as never,
      { getConfig: () => ({}) },
    );
    recordResult({
      toolName: "web_run",
      details: {
        route: "stock",
        webRun: {
          search_results: [
            {
              ref_id: "turn0search0",
              url: "https://www.typescriptlang.org/docs/handbook/intro",
            },
          ],
        },
      },
    });

    expect(transform("Typed JavaScript. citeturn0search0", { messageType: "assistant" })).toBe(
      "Typed JavaScript. [source](<https://www.typescriptlang.org/docs/handbook/intro>)",
    );
    expect(transform("Unknown. citeturn9view9", { messageType: "assistant" })).toBe(
      "Unknown. [web source]",
    );
    expect(transform("citeturn0search0", { messageType: "user" })).toBe("citeturn0search0");
  });
});
