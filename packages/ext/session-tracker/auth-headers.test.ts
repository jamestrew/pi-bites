import { expect, test } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { inferNeedsInputFromAssistantText } from "./index.js";

test("forwards provider header deletion markers to pi-ai unchanged", async () => {
  const model = { provider: "test", id: "small" };
  const headers = { "X-Keep": "yes", "X-Delete": null };
  let receivedHeaders: unknown;
  const complete = async (_model: unknown, _context: unknown, options?: { headers?: unknown }) => {
    receivedHeaders = options?.headers;
    return {
      role: "assistant",
      content: [{ type: "text", text: "IDLE" }],
      stopReason: "stop",
    } as never;
  };
  const ctx = {
    model,
    modelRegistry: {
      getAll: () => [model],
      getAvailable: () => [model],
      find: () => model,
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test", headers }),
    },
  } as unknown as ExtensionContext;

  await inferNeedsInputFromAssistantText(
    "done",
    ctx,
    { smallModel: { model: "test/small" } },
    complete as never,
  );

  expect(receivedHeaders).toBe(headers);
});
