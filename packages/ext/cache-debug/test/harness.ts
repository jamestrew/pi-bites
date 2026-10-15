import { expect, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerCacheDebug from "../index.js";

export function harness(
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
      diagnostics?: unknown[];
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
        diagnostics: options.diagnostics,
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
    invalidateContext: () => {
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
