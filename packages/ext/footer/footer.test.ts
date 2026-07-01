import { mkdirSync, mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { visibleWidth } from "@earendil-works/pi-tui";

import {
  buildFooterLine,
  ExploreUsageReader,
  TauFooterStatusReader,
  formatTauFooterStatus,
  formatUsageStats,
  type UsageTotals,
} from "./index.js";
import type { TauDashboardSession } from "../../tau/index.js";

const footerData = {
  getGitBranch: () => "main",
  getExtensionStatuses: () => new Map<string, string>(),
  onBranchChange: () => () => undefined,
};

function usage(overrides: Partial<UsageTotals> = {}): UsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, ...overrides };
}

function tauSession(overrides: Partial<TauDashboardSession>): TauDashboardSession {
  return {
    sessionId: "session-1",
    sessionFile: "/tmp/session.jsonl",
    cwd: "/repo",
    pid: 1,
    startedAt: 1,
    heartbeatAt: 1,
    lastEventAt: 1,
    activityAt: 1,
    sourceStatus: "idle",
    state: "idle",
    isLive: true,
    isStale: false,
    sessionFileExists: true,
    statusFile: "/tmp/status.json",
    ...overrides,
  };
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

test("formatTauFooterStatus summarizes session states", () => {
  expect(
    formatTauFooterStatus([
      tauSession({ state: "working" }),
      tauSession({ sessionId: "session-2", state: "idle", cwd: "/other" }),
      tauSession({ sessionId: "session-3", state: "idle", cwd: "/third" }),
    ]),
  ).toBe("Tau working:1 idle:2");
});

test("formatTauFooterStatus shows blocked session first", () => {
  expect(
    formatTauFooterStatus([
      tauSession({ state: "working", cwd: "/repo" }),
      tauSession({ sessionId: "session-2", state: "needs-permission", cwd: "/work/pi-bites" }),
      tauSession({ sessionId: "session-3", state: "idle", cwd: "/idle" }),
    ]),
  ).toBe("Tau needs-permission pi-bites · needs-permission:1 working:1 idle:1");
});

test("TauFooterStatusReader loads from the extension Tau agents dir", async () => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = join(tmpdir(), "pi", "agent");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const calls: string[] = [];

  try {
    const reader = new TauFooterStatusReader(() => undefined, {
      loadSessions: async ({ agentsDir }) => {
        calls.push(agentsDir);
        return { sessions: [], issues: [] };
      },
    });

    await reader.refresh();

    expect(calls).toEqual([join(tmpdir(), "pi", "agents")]);
  } finally {
    if (previousAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  }
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
