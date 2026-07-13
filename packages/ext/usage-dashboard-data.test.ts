import { describe, expect, it } from "vitest";
import { decodeSessionUsageEntry } from "./usage-dashboard-data.js";

describe("decodeSessionUsageEntry", () => {
  it("decodes assistant usage with the session-entry timestamp fallback", () => {
    expect(
      decodeSessionUsageEntry({
        type: "message",
        timestamp: "2026-01-02T03:04:05.000Z",
        message: {
          role: "assistant",
          provider: "anthropic",
          model: "claude",
          usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, cost: { total: 0.5 } },
        },
      }),
    ).toEqual({
      type: "message",
      message: {
        provider: "anthropic",
        model: "claude",
        cost: 0.5,
        input: 10,
        output: 20,
        cacheRead: 30,
        cacheWrite: 40,
        timestamp: 1_767_323_045_000,
      },
    });
  });

  it("rejects malformed entries and normalizes partial or non-finite usage", () => {
    expect(decodeSessionUsageEntry({ type: "session", id: "session-1" })).toEqual({
      type: "session",
      sessionId: "session-1",
    });
    expect(
      decodeSessionUsageEntry({ type: "message", message: { role: "assistant" } }),
    ).toBeUndefined();
    expect(decodeSessionUsageEntry(null)).toBeUndefined();

    expect(
      decodeSessionUsageEntry({
        type: "message",
        message: {
          role: "assistant",
          provider: "anthropic",
          model: "claude",
          timestamp: JSON.parse("1e400"),
          usage: { input: JSON.parse("1e400") },
        },
      }),
    ).toEqual({
      type: "message",
      message: {
        provider: "anthropic",
        model: "claude",
        cost: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        timestamp: 0,
      },
    });
  });
});
