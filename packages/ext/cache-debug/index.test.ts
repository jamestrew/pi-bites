import { afterEach, expect, test, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerCacheDebug from "./index.js";

afterEach(() => vi.restoreAllMocks());

function harness(
  modelId = "gpt-6.1-sol",
  provider = "openai-codex",
  api = "openai-codex-responses",
) {
  const handlers = new Map<string, (event: never, ctx: never) => unknown>();
  let command: (args: string, ctx: never) => Promise<void>;
  let renderer: (...args: never[]) => { render: (width: number) => string[] } | undefined;
  const entries: any[] = [];
  let now = 0;
  let wall = 1000;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.spyOn(Date, "now").mockImplementation(() => wall);
  const notify = vi.fn();
  const model = {
    provider,
    api,
    id: modelId,
    cost: { cacheRead: 0.5 },
  };
  let pricing = true;
  let paidRate = 0.000002;
  let branch: any[] = [];
  let branchReads = 0;
  let responseSequence = 0;
  let stale = false;
  function context(id: string) {
    return {
      get model() {
        if (stale) throw new Error("stale ctx");
        return model;
      },
      get sessionManager() {
        if (stale) throw new Error("stale ctx");
        return {
          getSessionId: () => id,
          getBranch: () => {
            branchReads++;
            return branch;
          },
        };
      },
      get modelRegistry() {
        if (stale) throw new Error("stale ctx");
        return { find: () => (pricing ? model : undefined) };
      },
      get ui() {
        if (stale) throw new Error("stale ctx");
        return { notify };
      },
    };
  }
  let ctx = context("session-A");
  const pi = {
    on: (event: string, handler: never) => {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
    appendEntry: (type: string, data: unknown) => entries.push({ type, data }),
    registerCommand: (_name: string, spec: { handler: typeof command }) => {
      command = spec.handler;
    },
    registerEntryRenderer: (_name: string, callback: typeof renderer) => {
      renderer = callback;
    },
  };
  registerCacheDebug(pi as unknown as ExtensionAPI);
  function emit(name: string, event: unknown = {}) {
    return handlers.get(name)?.(event as never, ctx as never);
  }
  emit("session_start", { reason: "startup" });
  function payload(overrides: Record<string, unknown> = {}) {
    return {
      model: model.id,
      instructions: "private instructions",
      store: false,
      stream: true,
      text: { verbosity: "medium" },
      include: ["reasoning.encrypted_content"],
      prompt_cache_key: "private cache key",
      tool_choice: "auto",
      parallel_tool_calls: true,
      tools: [{ type: "function", name: "private tool", parameters: { type: "object" } }],
      input: [{ role: "user", content: "private prompt" }],
      ...overrides,
    };
  }
  function request(body: unknown = payload(), gap = 1000) {
    now += gap;
    wall += gap;
    const before = structuredClone(body);
    expect(emit("before_provider_request", { payload: body })).toBeUndefined();
    expect(body).toEqual(before);
  }
  function terminal(
    read = 0,
    input = 66_000 - read,
    extra: Record<string, unknown> = {},
    id?: string,
  ) {
    const responseId = id ?? `response-${++responseSequence}`;
    emit("provider_stream_event", {
      provider: model.provider,
      api: model.api,
      model: model.id,
      data: {
        type: "response.completed",
        response: {
          id: responseId,
          usage: {
            input_tokens: input + read,
            output_tokens: 10,
            input_tokens_details: { cached_tokens: read },
          },
          ...extra,
        },
      },
    });
    return responseId;
  }
  function response(
    read = 0,
    input = 66_000 - read,
    options: {
      missing?: boolean;
      stopReason?: string;
      id?: string;
      cacheWrite?: number;
      noStream?: boolean;
    } = {},
  ) {
    const id = options.noStream
      ? undefined
      : terminal(read, input, options.missing ? { usage: undefined } : {}, options.id);
    const write = options.cacheWrite ?? 0;
    emit("message_end", {
      message: {
        role: "assistant",
        provider: model.provider,
        model: model.id,
        api: model.api,
        responseId: id,
        stopReason: options.stopReason ?? "stop",
        timestamp: -100,
        content: [{ type: "text", text: "private response" }],
        usage: {
          input,
          cacheRead: read,
          cacheWrite: write,
          output: 10,
          totalTokens: input + read + write + 10,
          cost: {
            input: input * paidRate,
            cacheRead: read * 0.0000005,
            cacheWrite: write * 0.000002,
            output: 0,
            total: 0,
          },
        },
      },
    });
  }
  function complete(read: number, body = payload(), gap = 1000, input = 66_000 - read) {
    request(body, gap);
    response(read, input);
  }
  function status() {
    void command("status", ctx as never);
    return notify.mock.calls.at(-1)?.[0] as string;
  }
  return {
    entries,
    branchReads: () => branchReads,
    emit,
    payload,
    request,
    response,
    terminal,
    complete,
    status,
    model,
    command: (arg: string) => command(arg, ctx as never),
    paidRate: (rate: number) => {
      paidRate = rate;
    },
    noPricing: () => {
      pricing = false;
    },
    rewrite: (type: string) => {
      branch.push({ type, id: `rewrite-${branch.length}` });
    },
    wallJump: (delta: number) => {
      wall += delta;
    },
    shutdown: () => {
      emit("session_shutdown");
      stale = true;
    },
    replace: (id: string, reason = "resume") => {
      stale = true;
      // Replacement owns new getters while every previously supplied ctx now throws.
      ctx = {
        model,
        sessionManager: {
          getSessionId: () => id,
          getBranch: () => {
            branchReads++;
            return branch;
          },
        },
        modelRegistry: { find: () => (pricing ? model : undefined) },
        ui: { notify },
      } as typeof ctx;
      emit("session_start", { reason });
    },
    render: (entry: unknown, expanded: boolean, width: number, styled = false) =>
      renderer(
        entry as never,
        { expanded } as never,
        {
          bold: (s: string) => (styled ? `<bold>${s}</bold>` : s),
          fg: (c: string, s: string) => (styled ? `<${c}>${s}</${c}>` : s),
        } as never,
      )?.render(width),
  };
}

test("default-on records a significant partial miss only at turn_end, with a self-contained private comparison", () => {
  const h = harness();
  h.complete(60_000);
  h.complete(65_000);
  h.complete(
    3968,
    h.payload({ input: [...h.payload().input, { role: "user", content: "private append" }] }),
    13_000,
  );
  expect(h.entries).toHaveLength(0);
  h.emit("turn_end");
  expect(h.entries).toHaveLength(1);
  const data = h.entries[0].data;
  expect(data).toMatchObject({
    missedTokens: 62_032,
    logicalRequestGapMs: 13_000,
    previous: { sequence: 2 },
    current: { sequence: 3 },
    inputComparison: {
      previousCount: 1,
      currentCount: 2,
      commonPrefix: 1,
      firstDifference: null,
      historicalInputChanged: false,
    },
  });
  expect(data.observations).toEqual([
    "No request-prefix mutation observed; transport/provider cause remains unresolved.",
  ]);
  expect(JSON.stringify(data)).not.toMatch(/private|response-\d|monotonic|terminal/);
  expect(h.render(h.entries[0], true, 40)?.join("\n")).toContain("Logical request gap:");
});

test.each([
  ["instructions", { instructions: "changed" }, "Leading instructions changed."],
  ["tools", { tools: [] }, "Tool declarations changed."],
  ["key", { prompt_cache_key: undefined }, "Cache key changed."],
  ["options", { temperature: 0 }, "Fixed request options changed."],
  [
    "historical input",
    { input: [{ role: "user", content: "changed" }] },
    "Historical input prefix changed.",
  ],
])("retains %s changes even after long gaps", (_name, overrides, label) => {
  const h = harness();
  h.complete(60_000);
  h.complete(0, h.payload(overrides), 1_800_001);
  h.emit("turn_end");
  expect(h.entries[0].data.observations).toContain(label);
});

test("recognizes system/developer content, ordered tools, historical truncation and reordering", () => {
  const h = harness();
  const input = [{ role: "developer", content: "system" }, ...h.payload().input];
  h.complete(60_000, h.payload({ input }));
  h.complete(0, h.payload({ input: input.slice(0, 1) }));
  h.complete(0, h.payload({ input: [...input].reverse() }));
  h.emit("turn_end");
  expect(h.entries.map((entry) => entry.data.inputComparison)).toEqual([
    {
      previousCount: 2,
      currentCount: 1,
      commonPrefix: 1,
      firstDifference: 1,
      historicalInputChanged: true,
    },
    {
      previousCount: 1,
      currentCount: 2,
      commonPrefix: 0,
      firstDifference: 0,
      historicalInputChanged: true,
    },
  ]);
  const tools = [
    { type: "function", name: "a" },
    { type: "function", name: "b" },
  ];
  h.complete(60_000, h.payload({ tools }));
  h.complete(0, h.payload({ tools: tools.reverse() }));
  h.emit("turn_end");
  expect(h.entries.at(-1).data.observations).toContain("Tool declarations changed.");
});

test("elapsed time never suppresses a stable-prefix miss with unknown provider TTL", () => {
  const h = harness("claude-sonnet", "bedrock-proxy", "bedrock-converse-stream");
  h.request();
  h.response(60_000, 6000, { noStream: true });
  h.request(h.payload(), 24 * 60 * 60_000);
  h.response(0, 66_000, { noStream: true });
  h.emit("turn_end");
  expect(h.entries).toHaveLength(1);
  expect(h.entries[0].data.ttlPolicyMs).toBeNull();
  expect(h.entries[0].data.logicalRequestGapMs).toBe(24 * 60 * 60_000);
  expect(h.status()).toContain("TTL suppression: disabled");
});

test("model changes are observations, not resets", () => {
  const h = harness();
  h.complete(60_000);
  h.model.id = "gpt-5.5-codex";
  h.complete(0, h.payload(), 1_800_000);
  h.emit("turn_end");
  expect(h.entries[0].data.observations).toContain("Provider/model changed.");
});

test("off drops pending data and on resumes cold without control entries", async () => {
  const h = harness();
  h.complete(60_000);
  h.complete(0);
  await h.command("off");
  h.emit("turn_end");
  h.complete(0);
  h.emit("turn_end");
  expect(h.entries).toHaveLength(0);
  expect(h.status()).toContain("off");
  await h.command("on");
  h.complete(0);
  h.emit("turn_end");
  expect(h.entries).toHaveLength(0);
  h.complete(60_000);
  h.complete(0);
  h.emit("turn_end");
  expect(h.entries).toHaveLength(1);
});

test("cold starts and providers that never report cache activity are not misses", () => {
  const h = harness();
  h.complete(0);
  h.complete(0);
  h.emit("turn_end");
  expect(h.entries).toHaveLength(0);
  expect(h.status()).toContain("no reported cache activity");
});

test("unavailable pricing does not disable the token threshold", () => {
  const h = harness();
  h.noPricing();
  h.complete(60_000);
  h.complete(0);
  h.emit("turn_end");
  expect(h.entries[0].data.estimatedExcessCost).toBeNull();
  expect(h.entries[0].data.missedTokens).toBe(66_000);
});

test("cost significance and the 1,024 token guard match Pi", () => {
  const h = harness();
  h.complete(60_000);
  h.complete(0, h.payload(), 1000, 1024);
  h.emit("turn_end");
  expect(h.entries).toHaveLength(0);
  h.complete(60_000);
  h.complete(0, h.payload(), 1000, 19_999);
  h.emit("turn_end");
  expect(h.entries).toHaveLength(0);
  h.complete(60_000);
  h.complete(0, h.payload(), 1000, 20_000);
  h.emit("turn_end");
  expect(h.entries).toHaveLength(1);
});

test.each([
  "missing",
  "error",
  "aborted",
  "ambiguous",
  "identity",
  "duplicate terminal",
  "created mismatch",
])("%s invalidates continuity, without fabricating a hit or miss", (mode) => {
  const h = harness();
  h.complete(60_000);
  h.request();
  if (mode === "ambiguous") h.request();
  if (mode === "duplicate terminal") h.terminal();
  if (mode === "identity")
    h.emit("provider_stream_event", { provider: "other", api: h.model.api, model: h.model.id });
  if (mode === "created mismatch")
    h.emit("provider_stream_event", {
      provider: h.model.provider,
      api: h.model.api,
      model: h.model.id,
      data: { type: "response.created", response: { id: "different" } },
    });
  h.response(0, 66_000, {
    missing: mode === "missing",
    stopReason: ["error", "aborted"].includes(mode) ? mode : "stop",
  });
  h.emit("turn_end");
  expect(h.entries).toHaveLength(0);
  expect(h.status()).toContain("cold");
  h.complete(0);
  h.emit("turn_end");
  expect(h.entries).toHaveLength(0);
});

test.each([
  { previous_response_id: "secret" },
  { input: Array.from({ length: 2049 }, () => ({ role: "user", content: "x" })) },
  { tools: Array.from({ length: 129 }, () => ({ type: "function" })) },
  { instructions: "x".repeat(8 * 1024 * 1024) },
])("unsupported shapes and bounds are status-only limitations", (overrides) => {
  const h = harness();
  h.complete(60_000);
  h.complete(0, h.payload(overrides));
  h.emit("turn_end");
  expect(h.entries).toHaveLength(0);
  expect(h.status()).toMatch(/unsupported|incomplete|bounds exceeded/);
});

test("pending summaries are bounded and overflow cannot imply complete coverage", () => {
  const h = harness();
  h.complete(60_000);
  for (let i = 0; i < 10; i++) h.complete(0);
  expect(h.status()).toContain("bounds exceeded");
  h.emit("turn_end");
  expect(h.entries).toHaveLength(8);
});

test.each(["session_tree", "session_compact", "context_edit", "branch_summary", "compaction"])(
  "%s clears comparisons and pending anomalies",
  (event) => {
    const h = harness();
    h.complete(60_000);
    h.complete(0);
    if (event.startsWith("session_")) h.emit(event);
    else h.rewrite(event);
    h.complete(0);
    h.emit("turn_end");
    expect(h.entries).toHaveLength(0);
    h.complete(60_000);
    h.complete(0);
    h.emit("turn_end");
    expect(h.entries).toHaveLength(1);
    expect(h.entries[0].data.resetReason).toMatch(
      /branch navigation|successful compaction|context rewrite/,
    );
  },
);

test("failed compaction preserves continuity", () => {
  const h = harness();
  h.complete(60_000);
  h.emit("session_compact_failed");
  h.complete(0);
  h.emit("turn_end");
  expect(h.entries).toHaveLength(1);
});

test("replacement/reload cannot flush old pending data or dereference captured ctx", () => {
  const h = harness();
  h.complete(60_000);
  h.complete(0);
  h.replace("session-B");
  h.emit("turn_end");
  h.complete(60_000);
  h.complete(0);
  h.emit("turn_end");
  expect(h.entries).toHaveLength(1);
  expect(h.entries[0].data.sessionId).toBe("session-B");
  const keyBefore = h.entries[0].data.current.fingerprints.key;
  h.replace("session-B", "reload");
  h.complete(60_000);
  h.complete(0);
  h.emit("turn_end");
  expect(h.entries.at(-1).data.current.fingerprints.key).not.toBe(keyBefore);
});

test("wall-clock jumps do not infer expiry; backwards monotonic timing invalidates continuity", () => {
  const h = harness();
  h.complete(60_000);
  h.wallJump(86_400_000);
  h.complete(0);
  h.emit("turn_end");
  expect(h.entries[0].data.logicalRequestGapMs).toBe(1000);
  h.complete(0, h.payload(), -1000);
  h.emit("turn_end");
  expect(h.entries).toHaveLength(1);
  expect(h.status()).toContain("timing unavailable/discontinuous");
});

test("current Codex custom grammar tools and assistant items with omitted optional fields remain comparable", () => {
  const h = harness();
  const tools = [
    {
      type: "custom",
      name: "codemode",
      format: { type: "grammar", syntax: "lark", definition: "private grammar" },
    },
  ];
  const input = [
    {
      type: "message",
      role: "assistant",
      phase: undefined,
      content: [{ type: "output_text", text: "private text" }],
    },
  ];
  h.complete(60_000, h.payload({ tools, input, prompt_cache_key: undefined }));
  const reordered = [
    {
      content: [{ text: "private text", type: "output_text" }],
      role: "assistant",
      type: "message",
    },
  ];
  h.complete(0, h.payload({ tools, input: reordered, prompt_cache_key: undefined }));
  h.emit("turn_end");
  expect(h.entries).toHaveLength(1);
  expect(h.entries[0].data.inputComparison.historicalInputChanged).toBe(false);
  expect(h.entries[0].data.observations).toEqual([
    "No request-prefix mutation observed; transport/provider cause remains unresolved.",
  ]);
});

test("cost-qualified small misses are retained and negative excess cost is clamped", () => {
  const h = harness();
  h.paidRate(0.0001);
  h.complete(60_000);
  h.complete(0, h.payload(), 1000, 1025);
  h.emit("turn_end");
  expect(h.entries[0].data.estimatedExcessCost).toBeCloseTo(0.1019875);
  h.paidRate(0.0000001);
  h.complete(60_000);
  h.complete(0);
  h.emit("turn_end");
  expect(h.entries.at(-1).data.estimatedExcessCost).toBe(0);
});

test("system-message changes are instructions, not just whole-body differences", () => {
  const h = harness();
  h.complete(60_000, h.payload({ input: [{ role: "developer", content: "old" }] }));
  h.complete(0, h.payload({ input: [{ role: "developer", content: "new" }] }));
  h.emit("turn_end");
  expect(h.entries[0].data.observations).toEqual([
    "Leading instructions changed.",
    "Historical input prefix changed.",
  ]);
});

test("cache-write reporting establishes activity for a later zero-read miss", () => {
  const h = harness();
  h.request();
  h.response(0, 66_000, { cacheWrite: 1000 });
  h.complete(0);
  h.emit("turn_end");
  expect(h.entries[0].data.missedTokens).toBe(66_000);
});

test("unreported cached-token detail is coverage, not normalized zero usage", () => {
  const h = harness();
  h.complete(60_000);
  h.request();
  const responseId = h.terminal(0, 66_000, { usage: { input_tokens: 66_000, output_tokens: 10 } });
  h.emit("message_end", {
    message: {
      role: "assistant",
      provider: h.model.provider,
      model: h.model.id,
      responseId,
      stopReason: "stop",
      usage: {
        input: 66_000,
        output: 10,
        cacheRead: 0,
        cacheWrite: 0,
        cost: { input: 0.132, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.132 },
      },
    },
  });
  h.emit("turn_end");
  expect(h.entries).toHaveLength(0);
  expect(h.status()).toContain("missing usage");
});

test("a response ID mismatch and a missing response never advance the baseline", () => {
  const h = harness();
  h.complete(60_000);
  h.request();
  h.terminal(0, 66_000, {}, "provider-id");
  h.emit("message_end", { message: { role: "assistant", responseId: "other-id" } });
  expect(h.status()).toContain("cold");
  h.request();
  h.emit("turn_end");
  expect(h.entries).toHaveLength(0);
  expect(h.status()).toContain("without reliable response correlation");
});

test("inspection accepts custom providers/tools without exposing provider content in status", () => {
  const h = harness();
  h.complete(60_000);
  h.model.provider = "other";
  h.complete(0);
  h.emit("turn_end");
  expect(h.entries[0].data.observations).toContain("Provider/model changed.");
  h.complete(0, h.payload({ tools: [{ type: "custom-proxy-tool", definition: "private tool" }] }));
  h.emit("turn_end");
  expect(h.entries[1].data.observations).toContain("Tool declarations changed.");
  expect(JSON.stringify(h.entries)).not.toContain("private tool");
  const payload = h.payload();
  Object.defineProperty(payload, "instructions", {
    get() {
      throw new Error("private getter content");
    },
  });
  h.emit("before_provider_request", { payload });
  expect(h.status()).not.toContain("private getter content");
});

test("bounded recursive inspection reports both depth and node overflow", () => {
  const h = harness();
  let deep: unknown = "x";
  for (let i = 0; i < 65; i++) deep = { child: deep };
  h.complete(0, h.payload({ input: [{ content: deep }] }));
  h.emit("turn_end");
  expect(h.status()).toContain("bounds exceeded");
  h.complete(0, h.payload({ input: [{ content: Array.from({ length: 100_001 }, () => 0) }] }));
  h.emit("turn_end");
  expect(h.status()).toContain("bounds exceeded");
  expect(h.entries).toHaveLength(0);
});

test("shutdown ignores late callbacks with throwing getters and resumes capture on a fresh lifecycle", () => {
  const h = harness();
  h.complete(60_000);
  h.complete(0);
  h.shutdown();
  h.emit("before_provider_request", { payload: h.payload() });
  h.emit("provider_stream_event", {});
  h.emit("session_tree");
  h.emit("session_compact");
  h.emit("message_end", { message: { role: "assistant" } });
  h.emit("turn_end");
  expect(h.entries).toHaveLength(0);
  h.replace("session-C", "new");
  h.complete(60_000);
  h.complete(0);
  h.emit("turn_end");
  expect(h.entries).toHaveLength(1);
  expect(h.entries[0].data.sessionId).toBe("session-C");
});

test("ignored provider deltas do not scan the session branch, with or without an in-flight observation", () => {
  const h = harness();
  const ignored = {
    provider: h.model.provider,
    api: h.model.api,
    model: h.model.id,
    data: { type: "response.output_text.delta", delta: "private text" },
  };
  let before = h.branchReads();
  for (let i = 0; i < 1000; i++) h.emit("provider_stream_event", ignored);
  expect(h.branchReads()).toBe(before);
  h.request();
  before = h.branchReads();
  for (let i = 0; i < 1000; i++) h.emit("provider_stream_event", ignored);
  expect(h.branchReads()).toBe(before);
  h.response(60_000);
  h.complete(0);
  h.emit("turn_end");
  expect(h.entries).toHaveLength(1);
});

test("transcript rows keep a styled scanline, safe width and a collapsed expansion hint", () => {
  const h = harness();
  h.complete(60_000);
  h.complete(0);
  h.emit("turn_end");
  const collapsed = h.render(h.entries[0], false, 1000, true)!;
  expect(collapsed[0]?.trimEnd()).toBe(
    "<bold>Cache</bold><accent> estimated lost reuse 66,000 tokens</accent>",
  );
  expect(collapsed.at(-1)?.trimEnd()).toMatch(/^<dim>\(.*to expand\)<\/dim>$/);
  for (const expanded of [false, true]) {
    const lines = h.render(h.entries[0], expanded, 30)!;
    expect(lines.every((line) => line.length <= 30)).toBe(true);
  }
  expect(h.render(h.entries[0], true, 1000)?.at(-1)).not.toContain("to expand");
});

const providerRequests = [
  {
    provider: "github-copilot",
    api: "openai-completions",
    body: {
      model: "gpt-4.1",
      messages: [
        { role: "system", content: "private instructions" },
        { role: "user", content: "private prompt" },
      ],
      tools: [{ type: "function", function: { name: "private tool" } }],
      temperature: 0.5,
    },
  },
  {
    provider: "github-copilot",
    api: "anthropic-messages",
    body: {
      model: "claude-sonnet",
      system: [{ type: "text", text: "private instructions" }],
      messages: [{ role: "user", content: "private prompt" }],
      tools: [{ name: "private tool", input_schema: { type: "object" } }],
      max_tokens: 4096,
    },
  },
  {
    provider: "bedrock-proxy",
    api: "bedrock-converse-stream",
    body: {
      modelId: "anthropic.claude-sonnet",
      system: [{ text: "private instructions" }],
      messages: [{ role: "user", content: [{ text: "private prompt" }] }],
      toolConfig: { tools: [{ toolSpec: { name: "private tool" } }], toolChoice: { auto: {} } },
      inferenceConfig: { maxTokens: 4096 },
    },
  },
  {
    provider: "custom-proxy",
    api: "openai-responses",
    body: {
      model: "gpt-4.1",
      input: [
        { role: "developer", content: "private instructions" },
        { role: "user", content: "private prompt" },
      ],
      tools: [{ type: "function", name: "private tool" }],
      custom_sampling: 0.5,
    },
  },
  {
    provider: "custom-google",
    api: "google-generative-ai",
    body: {
      contents: [{ role: "user", parts: [{ text: "private prompt" }] }],
      config: {
        systemInstruction: "private instructions",
        tools: [{ functionDeclarations: [{ name: "private tool" }] }],
      },
    },
  },
  {
    provider: "custom-api",
    api: "private-protocol",
    body: { transcript: ["private prompt"], settings: { temperature: 0.5 } },
  },
];

test.each(providerRequests)(
  "$provider/$api records misses without Responses-specific stream events",
  ({ provider, api, body }) => {
    const h = harness("proxy-model", provider, api);
    h.request(body);
    h.response(60_000, 6000, { noStream: true });
    h.request(body);
    h.response(0, 66_000, { noStream: true });
    h.emit("turn_end");
    expect(h.entries).toHaveLength(1);
    expect(h.entries[0].data.current).toMatchObject({ provider, api, model: "proxy-model" });
    expect(h.entries[0].data.missedTokens).toBe(66_000);
    expect(h.entries[0].data.coverage.join(" ")).toContain("normalized usage");
    expect(JSON.stringify(h.entries)).not.toContain("private prompt");
    expect(JSON.stringify(h.entries)).not.toContain("private instructions");
    expect(JSON.stringify(h.entries)).not.toContain("private tool");
  },
);

test("Bedrock binary input is fingerprinted without persisting or changing its bytes", () => {
  const h = harness("claude-sonnet", "bedrock-proxy", "bedrock-converse-stream");
  const body = {
    messages: [
      { role: "user", content: [{ image: { source: { bytes: new Uint8Array([1, 2, 3]) } } }] },
    ],
  };
  h.request(body);
  h.response(60_000, 6000, { noStream: true });
  const changed = structuredClone(body);
  changed.messages[0]!.content[0]!.image.source.bytes[0] = 4;
  h.request(changed);
  h.response(0, 66_000, { noStream: true });
  h.emit("turn_end");
  expect(h.entries).toHaveLength(1);
  expect(h.entries[0].data.observations).toContain("Historical input prefix changed.");
  expect(h.entries[0].data.current.fingerprints.input).toHaveLength(1);
});

test.each([undefined, {}, { input: 66_000, output: 10, cacheRead: 0, cacheWrite: 0 }])(
  "missing normalized usage/cost invalidates continuity without stream events",
  (usage) => {
    const h = harness("claude-sonnet", "bedrock-proxy", "bedrock-converse-stream");
    h.request();
    h.response(60_000, 6000, { noStream: true });
    h.request();
    h.emit("message_end", {
      message: {
        role: "assistant",
        provider: h.model.provider,
        model: h.model.id,
        api: h.model.api,
        stopReason: "stop",
        usage,
      },
    });
    h.emit("turn_end");
    expect(h.entries).toHaveLength(0);
    expect(h.status()).toContain("missing usage");
    expect(h.status()).toContain("cold");
  },
);

test("custom sampling options participate in the comparison", () => {
  const h = harness("proxy-model", "copilot-proxy", "openai-completions");
  const body = { messages: [{ role: "user", content: "private prompt" }], top_k: 10 };
  h.request(body);
  h.response(60_000, 6000, { noStream: true });
  h.request({ ...body, top_k: 20 });
  h.response(0, 66_000, { noStream: true });
  h.emit("turn_end");
  expect(h.entries[0].data.observations).toEqual(["Fixed request options changed."]);
});

test("payload model aliases and additional history fields are not silently excluded", () => {
  const h = harness("proxy-model", "custom-proxy", "openai-completions");
  const body = {
    model: "upstream-a",
    messages: [{ role: "user", content: "private prompt" }],
    input: [{ role: "user", content: "extra history" }],
  };
  h.request(body);
  h.response(60_000, 6000, { noStream: true });
  h.request({
    ...body,
    model: "upstream-b",
    messages: [{ role: "user", content: "changed history" }],
  });
  h.response(0, 66_000, { noStream: true });
  h.emit("turn_end");
  expect(h.entries[0].data.observations).toContain("Fixed request options changed.");
});

test("binary fingerprints cannot swallow adjacent JSON values", () => {
  const h = harness("claude-sonnet", "bedrock-proxy", "bedrock-converse-stream");
  h.request({ messages: [{ content: [new Uint8Array([97]), 1] }] });
  h.response(60_000, 6000, { noStream: true });
  h.request({ messages: [{ content: [new Uint8Array([97, 44, 49])] }] });
  h.response(0, 66_000, { noStream: true });
  h.emit("turn_end");
  expect(h.entries[0].data.observations).toContain("Historical input prefix changed.");
});

test.each([
  { body: { input: "private prompt" }, historyField: "whole payload" },
  { body: { input: { text: "private prompt" } }, historyField: "whole payload" },
  {
    body: {
      messages: [{ role: "user", content: "private prompt" }],
      tools: { custom: "private tool" },
    },
    historyField: "whole payload",
  },
  {
    body: { input: "private prompt", messages: [{ role: "user", content: "private history" }] },
    historyField: "messages",
  },
])(
  "custom field shapes retain privacy-safe diagnostics using $historyField",
  ({ body, historyField }) => {
    const h = harness("proxy-model", "custom-proxy", "private-protocol");
    h.request(body);
    h.response(60_000, 6000, { noStream: true });
    h.request({ ...body, sampling: "changed" });
    h.response(0, 66_000, { noStream: true });
    h.emit("turn_end");
    expect(h.entries).toHaveLength(1);
    expect(h.entries[0].data.current.fingerprints.historyField).toBe(historyField);
    expect(h.entries[0].data.observations).toContain("Fixed request options changed.");
    expect(JSON.stringify(h.entries)).not.toContain("private prompt");
    expect(JSON.stringify(h.entries)).not.toContain("private tool");
    expect(JSON.stringify(h.entries)).not.toContain("private history");
  },
);
