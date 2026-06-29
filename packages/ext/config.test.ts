import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

let agentDir = "";

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => agentDir,
}));

afterEach(() => {
  if (agentDir) rmSync(agentDir, { recursive: true, force: true });
  agentDir = "";
});

describe("loadConfig", () => {
  test("merges ponytail config from native pi-bites files", async () => {
    const project = mkdtempSync(join(tmpdir(), "pi-bites-project-"));
    agentDir = mkdtempSync(join(tmpdir(), "pi-bites-agent-"));

    writeFileSync(
      join(agentDir, "pi-bites.json"),
      JSON.stringify({ ponytail: { defaultMode: "lite" } }),
    );
    mkdirSync(join(project, ".pi"));
    writeFileSync(
      join(project, ".pi", "pi-bites.json"),
      JSON.stringify({ ponytail: { defaultMode: "ultra" } }),
      { flag: "wx" },
    );

    const { loadConfig } = await import("./config.js");
    expect(loadConfig(project).ponytail?.defaultMode).toBe("ultra");

    rmSync(project, { recursive: true, force: true });
  });
});
