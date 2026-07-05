import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { visibleWidth } from "@earendil-works/pi-tui";

import {
  buildExtensionStatusLines,
  buildFooterLine,
  ExploreUsageReader,
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
        ["ponytail", "○ 🐴 ponytail: ⚡ FULL"],
        ["session-tracker", "pi-sessions: 1 · 1 idle"],
      ]),
      120,
    ),
  ).toEqual(["○ 🐴 ponytail: ⚡ FULL codex: 5h: 4%", "pi-sessions: 1 · 1 idle"]);
});

test("ExploreUsageReader reset starts counting from current file end", () => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = mkdtempSync(join(tmpdir(), "pi-bites-footer-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;

  try {
    const usageDir = join(agentDir, "pi-bites", "usage");
    mkdirSync(usageDir, { recursive: true });
    const usageFile = join(usageDir, "explore.jsonl");
    writeFileSync(
      usageFile,
      JSON.stringify({
        type: "subagent_usage",
        subagent: "explore",
        usage: { input: 100, output: 100, cacheRead: 100, cost: 1 },
      }) + "\n",
    );

    const reader = new ExploreUsageReader();
    reader.reset();
    appendFileSync(
      usageFile,
      JSON.stringify({
        type: "subagent_usage",
        subagent: "explore",
        usage: { input: 2, output: 3, cacheRead: 5, cost: 0.01 },
      }) + "\n",
    );

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

test("ExploreUsageReader counts non-explore subagent files", () => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = mkdtempSync(join(tmpdir(), "pi-bites-footer-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;

  try {
    const usageDir = join(agentDir, "pi-bites", "usage");
    mkdirSync(usageDir, { recursive: true });
    writeFileSync(
      join(usageDir, "subagents.jsonl"),
      JSON.stringify({
        type: "subagent_usage",
        subagent: "general-purpose",
        usage: { input: 7, output: 8, cacheRead: 9, cacheWrite: 10, cost: { total: 0.02 } },
      }) + "\n",
    );

    const reader = new ExploreUsageReader();

    expect(reader.readNewUsage()).toEqual({
      input: 7,
      output: 8,
      cacheRead: 9,
      cacheWrite: 10,
      cost: 0.02,
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
