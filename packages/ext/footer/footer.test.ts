import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { visibleWidth } from "@earendil-works/pi-tui";

import {
  buildExtensionStatusLines,
  buildFooterLine,
  SubagentUsageReader,
  formatUsageStats,
  type UsageTotals,
} from "./index.js";

const footerData = {
  getGitBranch: () => "main",
  getExtensionStatuses: () => new Map<string, string>(),
  onBranchChange: () => () => undefined,
};

function usage(overrides: Partial<UsageTotals> = {}): UsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, ...overrides };
}

test("formatUsageStats renders compact labels and cache hit percentage", () => {
  expect(
    formatUsageStats(usage({ input: 1_000, output: 250, cacheRead: 3_000, cost: 0.1234 })),
  ).toBe("↑1.0k ↓250 R3.0k CH75.0% $0.123");
});

test("buildFooterLine combines main and explore token usage", () => {
  const ctx: any = {
    cwd: "/repo",
    model: { provider: "openai-codex", id: "gpt-5.5", contextWindow: 272_000 },
    getContextUsage: () => ({ tokens: 27_000, contextWindow: 272_000, percent: 7.7 }),
    sessionManager: {
      getBranch: () => [{ type: "thinking_level_change", thinkingLevel: "low" }],
      getEntries: () => [
        {
          type: "message",
          message: {
            role: "assistant",
            usage: {
              input: 40_000,
              output: 3_000,
              cacheRead: 80_000,
              cacheWrite: 0,
              cost: { total: 0.3 },
            },
          },
        },
      ],
    },
  };

  const line = buildFooterLine(
    ctx,
    footerData,
    usage({ input: 6_000, output: 100, cacheRead: 3_000, cost: 0.068 }),
    140,
  );

  expect(line).toContain("openai-codex/gpt-5.5 low · 27k/272k 7.7%");
  expect(line).toContain("↑46k ↓3.1k R83k CH64.3% $0.368");
  expect(line).toContain("/repo (main)");
});

test("buildExtensionStatusLines gives session tracker its own line", () => {
  expect(
    buildExtensionStatusLines(
      new Map([
        ["token-count", "codex: 5h: 4%"],
        ["session-tracker", "pi-sessions: 1 · 1 idle"],
      ]),
      120,
    ),
  ).toEqual(["codex: 5h: 4%", "pi-sessions: 1 · 1 idle"]);
});

test("SubagentUsageReader includes existing usage for its parent session", () => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = mkdtempSync(join(tmpdir(), "pi-bites-footer-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;

  try {
    const usageDir = join(agentDir, "pi-bites", "usage");
    mkdirSync(usageDir, { recursive: true });
    const usageFile = join(usageDir, "explore.jsonl");
    writeFileSync(
      usageFile,
      [
        {
          type: "subagent_usage",
          subagent: "explore",
          sessionId: "agent-1",
          parentSessionId: "parent-1",
          timestamp: 1,
          provider: "anthropic",
          model: "claude",
          usage: { input: 2, output: 3, cacheRead: 5, cost: 0.01 },
        },
        {
          type: "automode_usage",
          version: 1,
          parentSessionId: "parent-1",
          timestamp: 2,
          provider: "anthropic",
          model: "claude",
          usage: { input: 100, output: 100, cacheRead: 100, cost: { total: 1 } },
        },
      ]
        .map((record) => JSON.stringify(record))
        .join("\n") + "\n",
    );

    const reader = new SubagentUsageReader("parent-1");

    expect(reader.readNewUsage()).toEqual({
      input: 2,
      output: 3,
      cacheRead: 5,
      cacheWrite: 0,
      cost: 0.01,
    });
  } finally {
    rmSync(agentDir, { recursive: true, force: true });

    if (previousAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  }
});

test("SubagentUsageReader only counts subagents owned by its parent session", () => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = mkdtempSync(join(tmpdir(), "pi-bites-footer-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;

  try {
    const usageDir = join(agentDir, "pi-bites", "usage");
    mkdirSync(usageDir, { recursive: true });
    const usageFile = join(usageDir, "subagents.jsonl");
    writeFileSync(usageFile, "");

    const owningReader = new SubagentUsageReader("parent-1");
    const idleReader = new SubagentUsageReader("parent-2");

    appendFileSync(
      usageFile,
      [
        {
          type: "subagent_usage",
          subagent: "general-purpose",
          sessionId: "general-1",
          parentSessionId: "parent-1",
          timestamp: 1,
          provider: "anthropic",
          model: "claude",
          usage: {
            input: 7,
            output: 8,
            cacheRead: 9,
            cacheWrite: 10,
            cost: { total: 0.02 },
          },
        },
        {
          type: "subagent_usage",
          subagent: "explore",
          sessionId: "legacy-agent",
          usage: { input: 100, output: 100, cacheRead: 100, cost: 1 },
        },
      ]
        .map((record) => JSON.stringify(record))
        .join("\n") + "\n",
    );

    expect(owningReader.readNewUsage()).toEqual({
      input: 7,
      output: 8,
      cacheRead: 9,
      cacheWrite: 10,
      cost: 0.02,
    });
    expect(idleReader.readNewUsage()).toEqual(usage());
  } finally {
    rmSync(agentDir, { recursive: true, force: true });

    if (previousAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  }
});

test("buildFooterLine truncates on narrow terminals", () => {
  const ctx: any = {
    cwd: "/very/long/path/to/project",
    model: { provider: "provider", id: "model", contextWindow: 100_000 },
    getContextUsage: () => ({ tokens: 10_000, contextWindow: 100_000, percent: 10 }),
    sessionManager: { getBranch: () => [], getEntries: () => [] },
  };

  const line = buildFooterLine(ctx, footerData, usage(), 30);
  expect(visibleWidth(line)).toBeLessThanOrEqual(30);
});
