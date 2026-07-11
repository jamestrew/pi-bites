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
        smallModel: { model: "github-copilot/claude-haiku-4.5", thinking: "low" },
      }),
    );
    mkdirSync(join(project, ".pi"));
    writeFileSync(
      join(project, ".pi", "pi-bites.json"),
      JSON.stringify({
        ponytail: { defaultMode: "ultra" },
        smallModel: { thinking: "minimal" },
      }),
      { flag: "wx" },
    );

    const { loadConfig } = await import("./config.js");
    const config = loadConfig(project);
    expect(config.ponytail?.defaultMode).toBe("ultra");
    expect(config.smallModel).toEqual({
      model: "github-copilot/claude-haiku-4.5",
      thinking: "minimal",
    });

    rmSync(project, { recursive: true, force: true });
  });
});
