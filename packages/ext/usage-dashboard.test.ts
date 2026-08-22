import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectUsageData, UsageComponent } from "./usage-dashboard.js";

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
let agentDir: string | undefined;

afterEach(async () => {
  if (agentDir) await rm(agentDir, { recursive: true, force: true });
  agentDir = undefined;
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
});

describe("usage dashboard auxiliary records", () => {
  it("groups Auto Mode by actual provider/model and uses existing totals and insights", async () => {
    agentDir = await mkdtemp(join(tmpdir(), "pi-bites-usage-dashboard-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const now = Date.now();
    const startOfWeek = new Date(now);
    const dayOfWeek = startOfWeek.getDay();
    startOfWeek.setDate(startOfWeek.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
    startOfWeek.setHours(0, 0, 0, 0);
    const lastWeek = startOfWeek.getTime() - 1;
    const sessionsDir = join(agentDir, "sessions", "project");
    const usageDir = join(agentDir, "pi-bites", "usage");
    await mkdir(sessionsDir, { recursive: true });
    await mkdir(usageDir, { recursive: true });
    await writeFile(
      join(sessionsDir, "parent.jsonl"),
      [
        { type: "session", id: "parent-1" },
        {
          type: "message",
          message: {
            role: "assistant",
            provider: "main-provider",
            model: "main-model",
            timestamp: now,
            usage: {
              input: 1,
              output: 2,
              cacheRead: 3,
              cacheWrite: 4,
              cost: { total: 0.5 },
            },
          },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );
    await writeFile(
      join(usageDir, "automode.jsonl"),
      [
        {
          type: "automode_usage",
          version: 1,
          parentSessionId: "parent-1",
          timestamp: now + 1,
          provider: "provider-a",
          model: "shared/model",
          usage: {
            input: 160_000,
            output: 20,
            cacheRead: 30,
            cacheWrite: 40,
            totalTokens: 160_090,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 1 },
          },
        },
        {
          type: "automode_usage",
          version: 1,
          parentSessionId: "parent-1",
          timestamp: now + 2,
          provider: "provider-a/shared",
          model: "model",
          usage: {
            input: 10,
            output: 20,
            cacheRead: 30,
            cacheWrite: 40,
            totalTokens: 100,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 2 },
          },
        },
        {
          type: "automode_usage",
          version: 1,
          parentSessionId: "parent-1",
          timestamp: lastWeek,
          provider: "provider-a",
          model: "shared/model",
          usage: {
            input: 1,
            output: 2,
            cacheRead: 3,
            cacheWrite: 4,
            totalTokens: 10,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 4 },
          },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );

    const data = await collectUsageData();
    expect(data).not.toBeNull();
    const today = data!.today;
    const autoMode = today.providers.get("Auto Mode");

    expect(autoMode).toMatchObject({ messages: 2, cost: 3 });
    expect([...autoMode!.models.keys()].sort()).toEqual([
      '["provider-a","shared/model"]',
      '["provider-a/shared","model"]',
    ]);

    const theme = {
      fg: (_color: string, value: string) => value,
      bold: (value: string) => value,
    };
    const component = new UsageComponent(
      theme as any,
      data!,
      () => undefined,
      () => undefined,
    );
    component.handleInput("\r");
    const rendered = component.render(120).join("\n");
    expect(rendered).toContain("provider-a/shared");
    expect(rendered).toContain("shared/model");

    expect(autoMode!.tokens).toEqual({
      total: 160_130,
      input: 160_010,
      output: 40,
      cacheRead: 60,
      cacheWrite: 80,
    });
    expect(today.totals).toMatchObject({ sessions: 1, messages: 3, cost: 3.5 });
    expect(today.totals.tokens.total).toBe(160_137);
    expect(data!.lastWeek.providers.get("Auto Mode")).toMatchObject({ messages: 1, cost: 4 });
    expect(data!.lastWeek.totals).toMatchObject({ sessions: 1, messages: 1, cost: 4 });
    expect(data!.allTime.totals).toMatchObject({ sessions: 1, messages: 4, cost: 7.5 });
    expect(data!.allTime.totals.tokens.total).toBe(160_144);
    expect(
      today.insights.insights.some((insight) => insight.headline.includes(">150k context")),
    ).toBe(true);
  });
});
