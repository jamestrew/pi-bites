import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

let agentDir = "";

vi.mock("@earendil-works/pi-coding-agent", () => ({
  CONFIG_DIR_NAME: ".pi",
  getAgentDir: () => agentDir,
}));

afterEach(() => {
  if (agentDir) rmSync(agentDir, { recursive: true, force: true });
  agentDir = "";
});

describe("loadConfig", () => {
  test("merges config from native pi-bites files", async () => {
    const project = mkdtempSync(join(tmpdir(), "pi-bites-project-"));
    agentDir = mkdtempSync(join(tmpdir(), "pi-bites-agent-"));

    writeFileSync(
      join(agentDir, "pi-bites.json"),
      JSON.stringify({
        ponytail: { defaultMode: "lite" },
        autoCompaction: { thresholdTokens: 150_000 },
        smallModel: { model: "github-copilot/claude-haiku-4.5", thinking: "low" },
      }),
    );
    mkdirSync(join(project, ".pi"));
    writeFileSync(
      join(project, ".pi", "pi-bites.json"),
      JSON.stringify({
        ponytail: { defaultMode: "ultra" },
        autoCompaction: { thresholdTokens: 120_000 },
        smallModel: { thinking: "minimal" },
      }),
      { flag: "wx" },
    );

    const { loadConfig, parseBitesConfig } = await import("./config.js");
    expect(
      parseBitesConfig({
        ponytail: { defaultMode: "full" },
        disable: ["checkpoints", "goal"],
      }),
    ).toBeDefined();
    expect(parseBitesConfig({ disable: ["not-an-extension"] })).toBeUndefined();
    expect(parseBitesConfig({ autoCompaction: { thresholdTokens: 0 } })).toBeUndefined();

    const config = loadConfig(project);
    expect(config.ponytail?.defaultMode).toBe("ultra");
    expect(config.autoCompaction?.thresholdTokens).toBe(120_000);
    expect(config.smallModel).toEqual({
      model: "github-copilot/claude-haiku-4.5",
      thinking: "minimal",
    });

    rmSync(project, { recursive: true, force: true });
  });

  test("reports malformed config and falls back safely", async () => {
    const project = mkdtempSync(join(tmpdir(), "pi-bites-project-"));
    agentDir = mkdtempSync(join(tmpdir(), "pi-bites-agent-"));
    mkdirSync(join(project, ".pi"));
    writeFileSync(join(project, ".pi", "pi-bites.json"), JSON.stringify({ disable: [42] }));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const { loadConfig } = await import("./config.js");
      expect(loadConfig(project)).toEqual({
        smallModel: {},
        statusline: {},
        bashGate: {},
        notifications: {},
        checkpoints: {},
        autoCompaction: {},
        ponytail: {},
        subagents: {},
      });
      expect(error).toHaveBeenCalledWith(expect.stringContaining("failed to parse project-local"));
    } finally {
      error.mockRestore();
      rmSync(project, { recursive: true, force: true });
    }
  });
});
