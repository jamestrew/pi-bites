import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_PROMPT_GUIDELINES,
  getAgentToolDescription,
  getAgentToolParameters,
} from "../agent-tool-description.js";
import { registerAgents, setDefaultsDisabled } from "../agent-types.js";
import { WAIT_AGENT_TIMEOUT_GUIDANCE } from "../register-wait-agent.js";
import { type AgentConfig } from "../types.js";

const testAgent: AgentConfig = {
  name: "scout",
  description: "Researches code. Includes extra detail.",
  builtinToolNames: ["read", "grep"],
  extensions: false,
  skills: false,
  model: "anthropic/claude-haiku-4-5-20251001",
  systemPrompt: "Research the codebase.",
  promptMode: "replace",
};

describe("Agent tool descriptions", () => {
  let projectDir: string;
  let globalDir: string;
  let originalCwd: string;
  let originalAgentDir: string | undefined;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "pi-agent-description-project-"));
    globalDir = mkdtempSync(join(tmpdir(), "pi-agent-description-global-"));
    originalCwd = process.cwd();
    originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = globalDir;
    process.chdir(projectDir);
    setDefaultsDisabled(true);
    registerAgents(new Map([[testAgent.name, testAgent]]));
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    setDefaultsDisabled(false);
    registerAgents(new Map());
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(globalDir, { recursive: true, force: true });
  });

  it("renders dynamic agent lists in full and compact templates", () => {
    expect(getAgentToolDescription("full")).toContain(
      "- scout: Researches code. Includes extra detail. (claude-haiku-4-5) (Tools: read, grep)",
    );
    expect(getAgentToolDescription("compact")).toContain(
      "- scout: Researches code. (Tools: read, grep)",
    );
    expect(getAgentToolDescription("full").length).toBeLessThan(3_000);
    expect(getAgentToolDescription("compact").length).toBeLessThan(2_000);
  });

  it("keeps fresh-agent and isolation mechanics visible", () => {
    for (const mode of ["full", "compact"] as const) {
      const description = getAgentToolDescription(mode);
      expect(description).toContain("no conversation memory");
      expect(description).toContain("cannot resume completed agents");
      expect(description).toContain('"worktree" isolation');
      expect(description).toContain("changes are saved to a branch");
    }

    expect(JSON.stringify(getAgentToolParameters().properties.isolation)).toContain(
      "removed automatically",
    );
  });

  it("keeps Explore retrieval-only in injected guidance", () => {
    const guidelines = AGENT_PROMPT_GUIDELINES.join("\n");
    expect(guidelines).toContain("high-fanout factual retrieval");
    expect(guidelines).toContain("documentation and third-party source reading");
    expect(guidelines).toContain("user explicitly asks to explore");
    expect(guidelines).toContain("after 2-4 targeted calls fail");
    expect(guidelines).toContain("known-path reads");
    expect(guidelines).toContain("direct searches likely to answer");
    expect(guidelines).toContain("review");
    expect(guidelines).toContain("judgment-heavy work");
    expect(guidelines).toContain("Read decisive files");
  });

  it("describes composable spawn-and-wait work", () => {
    const guidelines = AGENT_PROMPT_GUIDELINES.join("\n");
    expect(guidelines).toContain("Agent returns an agent ID immediately");
    expect(guidelines).toContain("Wait only for blocking results");
    expect(guidelines).toContain(WAIT_AGENT_TIMEOUT_GUIDANCE);
    expect(guidelines).toContain("another maximum-length WaitAgent call");
    expect(guidelines).not.toContain("progress checkpoint");
    expect(guidelines).not.toContain("wrap up");
    expect(getAgentToolParameters().properties).not.toHaveProperty("run_in_background");
  });

  it("uses project then global custom templates and falls back to full", () => {
    const projectConfigDir = join(projectDir, ".pi");
    const projectTemplate = join(projectConfigDir, "agent-tool-description.md");
    const globalTemplate = join(globalDir, "agent-tool-description.md");
    mkdirSync(projectConfigDir);
    writeFileSync(projectTemplate, "project: {{typeList}} @ {{agentDir}}");
    writeFileSync(globalTemplate, "global: {{compactTypeList}}");

    expect(getAgentToolDescription("custom")).toBe(
      `project: - scout: Researches code. Includes extra detail. ` +
        `(claude-haiku-4-5) (Tools: read, grep) @ ${globalDir}`,
    );

    unlinkSync(projectTemplate);
    expect(getAgentToolDescription("custom")).toBe(
      "global: - scout: Researches code. (Tools: read, grep)",
    );

    unlinkSync(globalTemplate);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(getAgentToolDescription("custom")).toBe(getAgentToolDescription("full"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('toolDescriptionMode is "custom"'));
    warn.mockRestore();
  });
});
