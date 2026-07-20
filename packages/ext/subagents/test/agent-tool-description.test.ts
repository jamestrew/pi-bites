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
  });

  it("describes explicit exploration and background-by-default behavior", () => {
    expect(getAgentToolDescription("full")).toContain(
      "Use Explore immediately when the user asks to explore",
    );
    expect(AGENT_PROMPT_GUIDELINES.join("\n")).toContain(
      "Use Explore immediately when the user asks to explore",
    );
    expect(JSON.stringify(getAgentToolParameters().properties.run_in_background)).toContain(
      "background by default",
    );
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
