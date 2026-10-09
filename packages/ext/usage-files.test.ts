import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendUsageRecord,
  decodeAutoModeUsageRecord,
  decodeSubagentUsageRecord,
  readUsageRecords,
  UsageFileReader,
  type SubagentUsageRecord,
} from "./usage-files.js";

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
      await appendUsageRecord(record);
      const content = await readFile(join(agentDir, "pi-bites", "usage", "automode.jsonl"), "utf8");
      expect(content).toBe(`${JSON.stringify(record)}\n`);
    } finally {
      await rm(agentDir, { recursive: true, force: true });
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  });
});

describe("Subagent usage records", () => {
  it("decodes the persisted subagent usage contract", () => {
    expect(
      decodeSubagentUsageRecord({
        type: "subagent_usage",
        subagent: "explorer",
        sessionId: "subagent-session-1",
        parentSessionId: "session-1",
        timestamp: 123,
        provider: "anthropic",
        model: "claude",
        usage: {
          input: 10,
          output: 20,
          cacheRead: 30,
          cacheWrite: 40,
          cost: { total: 0.5 },
        },
      }),
    ).toEqual({
      type: "subagent_usage",
      subagent: "explorer",
      sessionId: "subagent-session-1",
      parentSessionId: "session-1",
      timestamp: 123,
      provider: "anthropic",
      model: "claude",
      usage: {
        input: 10,
        output: 20,
        cacheRead: 30,
        cacheWrite: 40,
        cost: { total: 0.5 },
      },
    });
  });

  it("rejects malformed records and defaults legacy partial usage", () => {
    const base = {
      type: "subagent_usage",
      subagent: "explorer",
      sessionId: "session-1",
      timestamp: 123,
      provider: "anthropic",
      model: "claude",
    };

    expect(decodeSubagentUsageRecord({ ...base, usage: {} })?.usage).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: { total: 0 },
    });
    expect(decodeSubagentUsageRecord({ ...base, subagent: undefined, usage: {} })).toBeUndefined();
    expect(decodeSubagentUsageRecord({ ...base })).toBeUndefined();
    expect(decodeSubagentUsageRecord("bad")).toBeUndefined();
  });

  it("normalizes non-finite persisted numbers", () => {
    const decoded = decodeSubagentUsageRecord({
      type: "subagent_usage",
      subagent: "explorer",
      sessionId: "session-1",
      timestamp: JSON.parse("1e400"),
      provider: "anthropic",
      model: "claude",
      usage: {
        input: JSON.parse("1e400"),
        output: 2,
        cacheRead: 3,
        cacheWrite: 4,
        cost: { total: JSON.parse("1e400") },
      },
    });

    expect(decoded?.timestamp).toBe(0);
    expect(decoded?.usage).toEqual({
      input: 0,
      output: 2,
      cacheRead: 3,
      cacheWrite: 4,
      cost: { total: 0 },
    });
  });
});

describe("auxiliary usage files", () => {
  let previousAgentDir: string | undefined;
  let agentDir: string;
  let dir: string;
  let file: string;
  beforeEach(async () => {
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    agentDir = await mkdtemp(join(tmpdir(), "pi-bites-usage-files-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    dir = join(agentDir, "pi-bites", "usage");
    file = join(dir, "subagents.jsonl");
  });
  afterEach(async () => {
    await rm(agentDir, { recursive: true, force: true });
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  });

  const subagent: SubagentUsageRecord = {
    type: "subagent_usage",
    subagent: "é",
    sessionId: "child",
    parentSessionId: "parent",
    timestamp: 123,
    provider: "provider",
    model: "model",
    usage: { input: 7, output: 2, cacheRead: 3, cacheWrite: 4, cost: { total: 0.5 } },
  };

  it("makes both producers' appended payloads available to historical and incremental readers", async () => {
    const automode = decodeAutoModeUsageRecord({
      type: "automode_usage",
      version: 1,
      reviewer: "guardian",
      parentSessionId: "parent",
      timestamp: 124,
      provider: "provider",
      model: "model",
      usage: { input: 5, reasoning: 2, cacheWrite1h: 3, cost: { total: 0.25 } },
    })!;
    const reader = new UsageFileReader();
    expect(reader.readNewRecords()).toEqual([]);
    await appendUsageRecord(subagent);
    await appendUsageRecord(automode);
    expect(reader.readNewRecords()).toEqual([automode, subagent]);
    expect(reader.readNewRecords()).toEqual([]);
    expect(await Array.fromAsync(readUsageRecords())).toEqual([automode, subagent]);
  });

  it("starts a new generation on replacement and observed truncation", async () => {
    await appendUsageRecord(subagent);
    const reader = new UsageFileReader();
    expect(reader.readNewRecords()).toEqual([subagent]);
    const replacement = { ...subagent, usage: { ...subagent.usage, input: 5 } };
    await writeFile(join(dir, "replacement"), JSON.stringify(replacement) + "\n");
    await rename(join(dir, "replacement"), file);
    expect(reader.readNewRecords()).toEqual([replacement]);
    expect(reader.readNewRecords()).toEqual([]);
    await truncate(file);
    expect(reader.readNewRecords()).toEqual([]);
    await appendUsageRecord(subagent);
    expect(reader.readNewRecords()).toEqual([subagent]);
  });

  it("skips malformed complete records and retains split UTF-8 tails across reads", async () => {
    await mkdir(join(dir, "nested"), { recursive: true });
    const nestedFile = join(dir, "nested", "legacy.jsonl");
    const legacy = { type: "subagent_usage", subagent: "é", usage: { input: 3, cost: 0.1 } };
    const bytes = Buffer.from(JSON.stringify(legacy) + "\n");
    const split = bytes.indexOf(Buffer.from("é")) + 1;
    await writeFile(
      nestedFile,
      Buffer.concat([Buffer.from("bad json\n{}\n"), bytes.subarray(0, split)]),
    );
    await writeFile(join(dir, "ignored.txt"), JSON.stringify(legacy) + "\n");
    const reader = new UsageFileReader();
    expect(reader.readNewRecords()).toEqual([]);
    expect(await Array.fromAsync(readUsageRecords())).toEqual([]);
    await appendFile(nestedFile, bytes.subarray(split));
    const expected = [
      {
        type: "subagent_usage",
        subagent: "é",
        usage: { input: 3, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0.1 } },
      },
    ];
    expect(reader.readNewRecords()).toEqual(expected);
    expect(reader.readNewRecords()).toEqual([]);
    expect(await Array.fromAsync(readUsageRecords())).toEqual(expected);
  });
});
