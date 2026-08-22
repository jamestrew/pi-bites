import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendAutoModeUsageRecord, decodeAutoModeUsageRecord } from "./usage.js";

describe("Auto Mode usage records", () => {
  it("decodes the complete versioned usage payload", () => {
    expect(
      decodeAutoModeUsageRecord({
        type: "automode_usage",
        version: 1,
        parentSessionId: "parent-1",
        timestamp: 123,
        provider: "anthropic",
        model: "claude-sonnet",
        usage: {
          input: 10,
          output: 20,
          cacheRead: 30,
          cacheWrite: 40,
          cacheWrite1h: 4,
          reasoning: 5,
          totalTokens: 100,
          cost: {
            input: 0.1,
            output: 0.2,
            cacheRead: 0.3,
            cacheWrite: 0.4,
            total: 1,
          },
        },
      }),
    ).toEqual({
      type: "automode_usage",
      version: 1,
      parentSessionId: "parent-1",
      timestamp: 123,
      provider: "anthropic",
      model: "claude-sonnet",
      usage: {
        input: 10,
        output: 20,
        cacheRead: 30,
        cacheWrite: 40,
        cacheWrite1h: 4,
        reasoning: 5,
        totalTokens: 100,
        cost: {
          input: 0.1,
          output: 0.2,
          cacheRead: 0.3,
          cacheWrite: 0.4,
          total: 1,
        },
      },
    });
  });

  it("rejects malformed envelopes and normalizes partial or non-finite usage", () => {
    const base = {
      type: "automode_usage",
      version: 1,
      parentSessionId: "parent-1",
      timestamp: JSON.parse("1e400"),
      provider: "anthropic",
      model: "claude-sonnet",
      usage: { input: JSON.parse("1e400"), cost: { total: JSON.parse("1e400") } },
    };

    expect(decodeAutoModeUsageRecord(base)).toEqual({
      ...base,
      timestamp: 0,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    });
    expect(
      decodeAutoModeUsageRecord({
        ...base,
        timestamp: -1,
        usage: {
          input: -1,
          output: -2,
          cacheRead: -3,
          cacheWrite: -4,
          totalTokens: -10,
          cost: { total: -1 },
        },
      }),
    ).toMatchObject({
      timestamp: 0,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { total: 0 },
      },
    });
    expect(decodeAutoModeUsageRecord({ ...base, version: 2 })).toBeUndefined();
    expect(decodeAutoModeUsageRecord({ ...base, parentSessionId: "" })).toBeUndefined();
    expect(decodeAutoModeUsageRecord({ ...base, usage: undefined })).toBeUndefined();
    expect(decodeAutoModeUsageRecord("bad")).toBeUndefined();
  });

  it("appends records under the existing auxiliary usage directory", async () => {
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const agentDir = await mkdtemp(join(tmpdir(), "pi-bites-automode-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const record = decodeAutoModeUsageRecord({
      type: "automode_usage",
      version: 1,
      parentSessionId: "parent-1",
      timestamp: 123,
      provider: "anthropic",
      model: "claude-sonnet",
      usage: {},
    })!;

    try {
      await appendAutoModeUsageRecord(record);
      const content = await readFile(join(agentDir, "pi-bites", "usage", "automode.jsonl"), "utf8");
      expect(content).toBe(`${JSON.stringify(record)}\n`);
    } finally {
      await rm(agentDir, { recursive: true, force: true });
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  });
});
