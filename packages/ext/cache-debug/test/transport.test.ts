import { afterEach, expect, test, vi } from "vitest";
import { harness } from "./harness.js";

afterEach(() => vi.restoreAllMocks());

test("anomaly snapshots retain bounded HTTP attempts and safe transport failures on successful responses", () => {
  const h = harness();
  const http = (status: number, headers: Record<string, string> = {}) => {
    const event = { status, headers };
    const before = structuredClone(event);
    expect(h.emit("after_provider_response", event)).toBeUndefined();
    expect(event).toEqual(before);
  };
  h.request();
  http(200, { "X-Request-Id": "request-hit", authorization: "private credential" });
  h.response(60_000);
  h.request();
  http(429, { "x-request-id": "request-retry", "set-cookie": "private cookie" });
  http(200, {
    "openai-request-id": "request-miss",
    "request-id": "request-id\n",
    "x-request-id": "x".repeat(257),
    "retry-after": "private header",
  });
  h.response(0, undefined, {
    diagnostics: [
      {
        type: "provider_transport_failure",
        timestamp: 1234,
        error: { message: "private error", stack: "private stack" },
        details: {
          configuredTransport: "websocket",
          fallbackTransport: "sse",
          eventsEmitted: false,
          phase: "before_message_stream_start",
          requestBytes: 123,
          payload: "private prompt",
        },
      },
      { type: "private diagnostic", details: { requestBytes: 100 } },
      {
        type: "provider_transport_failure",
        timestamp: NaN,
        details: {
          configuredTransport: "private transport",
          fallbackTransport: "private fallback",
          eventsEmitted: "private boolean",
          phase: "private phase",
          requestBytes: Infinity,
        },
      },
    ],
  });
  // A late callback cannot alter the completed baseline.
  http(503, { "x-request-id": "late-response" });
  h.emit("turn_end");
  const data = h.entries[0].data;
  expect(data.previous.transport).toEqual({
    httpResponses: 1,
    httpAttempts: [{ status: 200, requestIds: { "x-request-id": "request-hit" } }],
    failures: [],
    diagnosticsTruncated: false,
  });
  expect(data.current.transport).toEqual({
    httpResponses: 2,
    httpAttempts: [
      { status: 429, requestIds: { "x-request-id": "request-retry" } },
      { status: 200, requestIds: { "openai-request-id": "request-miss" } },
    ],
    failures: [
      {
        type: "provider_transport_failure",
        timestamp: 1234,
        configuredTransport: "websocket",
        fallbackTransport: "sse",
        eventsEmitted: false,
        phase: "before_message_stream_start",
        requestBytes: 123,
      },
      { type: "provider_transport_failure" },
    ],
    diagnosticsTruncated: false,
  });
  expect(JSON.stringify(data)).not.toMatch(/private|late-response/);
});

test("HTTP metadata and diagnostics are bounded, reset with capture, and absent observations stay unknown", () => {
  const h = harness();
  h.complete(60_000);
  h.request();
  for (let i = 0; i < 20; i++)
    h.emit("after_provider_response", { status: 200, headers: { "x-request-id": `attempt-${i}` } });
  h.response(0, undefined, {
    diagnostics: Array.from({ length: 20 }, () => ({
      type: "provider_transport_failure",
      details: { requestBytes: -1 },
    })),
  });
  h.emit("turn_end");
  const data = h.entries[0].data;
  expect(data.previous.transport.httpResponses).toBe(0);
  expect(data.previous.transport.httpAttempts).toEqual([]);
  expect(data.current.transport.httpResponses).toBe(20);
  expect(data.current.transport.httpAttempts).toHaveLength(8);
  expect(data.current.transport.failures).toHaveLength(8);
  expect(data.current.transport.diagnosticsTruncated).toBe(true);
  expect(JSON.stringify(data)).not.toContain('"requestBytes":-1');
  void h.command("off");
  h.emit("after_provider_response", { status: 200, headers: { "x-request-id": "disabled" } });
  void h.command("on");
  h.complete(60_000);
  h.complete(0);
  h.emit("turn_end");
  expect(h.entries[1].data.previous.transport.httpResponses).toBe(0);
  expect(h.entries[1].data.current.transport.httpResponses).toBe(0);
  h.shutdown();
  h.emit("after_provider_response", { status: 200, headers: {} });
});

test("HTTP response inspection drops stale contexts and marks header inspection overflow", () => {
  const h = harness();
  h.request();
  h.invalidateContext();
  expect(() => h.emit("after_provider_response", { status: 200, headers: {} })).not.toThrow();
  h.replace("session-B");
  h.request();
  h.emit("after_provider_response", { status: NaN, headers: {} });
  h.response(60_000);
  h.request();
  h.emit("after_provider_response", {
    status: 200,
    headers: Object.fromEntries([
      ...Array.from({ length: 128 }, (_, i) => [`header-${i}`, "private header"]),
      ["x-request-id", "uninspected-id"],
    ]),
  });
  h.response(0);
  h.emit("turn_end");
  const data = h.entries[0].data;
  expect(data.previous.transport.httpAttempts).toEqual([{ requestIds: {} }]);
  expect(data.current.transport.httpAttempts).toEqual([
    { status: 200, requestIds: {}, requestIdsTruncated: true },
  ]);
  expect(JSON.stringify(data)).not.toMatch(/private|uninspected-id/);
});
