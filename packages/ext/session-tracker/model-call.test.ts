import { expect, test, vi } from "vitest";
import {
  ModelRegistry,
  ModelRuntime,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { fauxProvider, fauxAssistantMessage, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { inferNeedsInputFromAssistantText } from "./index.js";

test("classifies through the registry without retaining an ephemeral context", async () => {
  const model = { provider: "configured", id: "small" };
  const controller = new AbortController();
  let stale = false;
  const streamSimple = vi.fn(() => {
    stale = true;
    return {
      result: async () => ({
        content: [{ type: "text", text: "NEEDS_INPUT" }],
        stopReason: "stop",
      }),
    };
  });
  const values = {
    model,
    signal: controller.signal,
    modelRegistry: { getAll: () => [model], find: () => model, streamSimple },
  };
  const ctx = Object.defineProperties(
    {},
    Object.fromEntries(
      Object.entries(values).map(([key, value]) => [
        key,
        {
          get() {
            if (stale) throw new Error("stale ctx");
            return value;
          },
        },
      ]),
    ),
  ) as ExtensionContext;

  await expect(
    inferNeedsInputFromAssistantText("Please choose", ctx, {
      smallModel: { model: "configured/small", thinking: "high" },
    }),
  ).resolves.toBe(true);
  expect(streamSimple).toHaveBeenCalledWith(model, expect.anything(), {
    reasoning: "high",
    maxTokens: 16,
    timeoutMs: 10_000,
    signal: controller.signal,
  });
});

test.each([
  ["error", "authentication required"],
  ["error", "request timed out"],
  ["aborted", "request cancelled"],
])("rejects registry %s results: %s", async (stopReason, errorMessage) => {
  const model = { provider: "test", id: "small" };
  const ctx = {
    model,
    modelRegistry: {
      getAll: () => [model],
      find: () => model,
      streamSimple: () => ({ result: async () => ({ stopReason, errorMessage, content: [] }) }),
    },
  } as unknown as ExtensionContext;
  await expect(
    inferNeedsInputFromAssistantText("Choose", ctx, {
      smallModel: { model: "test/small" },
    }),
  ).rejects.toThrow(errorMessage);
});

test("the real registry resolves provider auth, headers, environment and base URL per call", async () => {
  const credentials = new InMemoryCredentialStore();
  const runtime = await ModelRuntime.create({
    credentials,
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  const faux = fauxProvider({
    provider: "classifier-fixture",
    models: [{ id: "small" }],
    tokensPerSecond: 0,
  });
  runtime.registerNativeProvider({
    ...faux.provider,
    auth: {
      apiKey: {
        name: "fixture",
        check: async () => ({ type: "api_key" }),
        resolve: async ({ credential }) => ({
          auth: {
            apiKey: credential?.key,
            baseUrl: "https://resolved.invalid",
            headers: { "X-Keep": "yes", "X-Delete": null },
          },
          env: credential?.env,
        }),
      },
    },
  });
  const registry = new ModelRegistry(runtime);
  const model = registry.find("classifier-fixture", "small");
  expect(model).toBeDefined();
  const run = new AbortController();
  const ctx = { model, modelRegistry: registry, signal: run.signal } as ExtensionContext;
  for (const key of ["initial", "rotated"]) {
    await credentials.modify("classifier-fixture", async () => ({
      type: "api_key",
      key,
      env: { REGION: "fixture" },
    }));
    const request = vi.fn((_context, options, _state, requestModel) => {
      expect(requestModel.baseUrl).toBe("https://resolved.invalid");
      expect(options).toMatchObject({
        apiKey: key,
        headers: { "X-Keep": "yes", "X-Delete": null },
        env: { REGION: "fixture" },
        reasoning: "high",
        maxTokens: 16,
        timeoutMs: 10_000,
      });
      expect(options.signal.aborted).toBe(false);
      return fauxAssistantMessage("IDLE");
    });
    faux.setResponses([request]);
    await expect(
      inferNeedsInputFromAssistantText("Done", ctx, {
        smallModel: { model: "classifier-fixture/small", thinking: "high" },
      }),
    ).resolves.toBe(false);
    expect(request).toHaveBeenCalledOnce();
  }
});
