import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_PROMPT_GUIDELINES,
  getAgentToolDescription,
  getAgentToolParameters,
} from "../agent-tool-description.js";
import { WAIT_AGENT_TIMEOUT_GUIDANCE } from "../register-wait-agent.js";

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
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(globalDir, { recursive: true, force: true });
  });

  it("renders only the embedded agent roles", () => {
    for (const mode of ["full", "compact"] as const) {
      const description = getAgentToolDescription(mode);
      expect(description).toContain("- general:");
      expect(description).toContain("- explore:");
      expect(description).not.toContain("Custom agents");
      expect(description).not.toContain(".pi/agents");
    }
    expect(getAgentToolDescription("full").length).toBeLessThan(4_000);
    expect(getAgentToolDescription("compact").length).toBeLessThan(2_000);
  });

  it("describes fresh agents on the shared filesystem", () => {
    for (const mode of ["full", "compact"] as const) {
      const description = getAgentToolDescription(mode);
      expect(description).toContain("no conversation memory");
      expect(description).toContain("cannot resume completed agents");
      expect(description).toContain("share the parent session's filesystem");
      expect(description).not.toContain("worktree");
    }

    expect(getAgentToolParameters().properties).not.toHaveProperty("isolation");
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
    expect(guidelines).toContain("Partition Explore's scope before launching");
    expect(guidelines).toContain("delegated files or topics");
    expect(guidelines).toContain("do not repeat its searches or reads while it runs");
    expect(guidelines).toContain("continue only non-overlapping work");

    for (const mode of ["full", "compact"] as const) {
      const description = getAgentToolDescription(mode);
      expect(description).toContain("Partition Explore's scope before launching");
      expect(description).toContain("delegated files or topics");
    }
  });

  it("describes composable spawn-and-wait work", () => {
    const guidelines = AGENT_PROMPT_GUIDELINES.join("\n");
    expect(guidelines).toContain("Agent returns an agent ID immediately");
    expect(guidelines).toContain("Wait only for blocking results");
    expect(guidelines).toContain("status check only when the reply informs a current decision");
    expect(guidelines).toContain("hurry an agent");
    expect(guidelines).toContain("Reviews must reach their original completion criterion");
    expect(guidelines).toContain("independent of elapsed time or a WaitAgent timeout");
    expect(guidelines).not.toContain("intermediate result answers");
    expect(guidelines).toContain(WAIT_AGENT_TIMEOUT_GUIDANCE);
    expect(guidelines).toContain("another maximum-length WaitAgent call");
    expect(guidelines).not.toContain("progress checkpoint");

    for (const mode of ["full", "compact"] as const) {
      const description = getAgentToolDescription(mode);
      expect(description).toContain("status check only when the reply informs a current decision");
      expect(description).toContain("Reviews must reach their original completion criterion");
    }
    expect(getAgentToolParameters().properties).not.toHaveProperty("run_in_background");
  });

  it("asks for a concrete question and semantic completion without enforcing either", () => {
    const guidelines = AGENT_PROMPT_GUIDELINES.join("\n");
    expect(guidelines).toContain("concrete question");
    expect(guidelines).toContain("done when");

    for (const mode of ["full", "compact"] as const) {
      const description = getAgentToolDescription(mode);
      expect(description).toContain("concrete question");
      expect(description).toContain("done when");
    }

    expect(getAgentToolParameters().properties.prompt.type).toBe("string");
  });

  it("uses project then global custom templates and falls back to full", () => {
    const projectConfigDir = join(projectDir, ".pi");
    const projectTemplate = join(projectConfigDir, "agent-tool-description.md");
    const globalTemplate = join(globalDir, "agent-tool-description.md");
    mkdirSync(projectConfigDir);
    writeFileSync(projectTemplate, "project: {{typeList}} @ {{agentDir}}");
    writeFileSync(globalTemplate, "global: {{compactTypeList}}");

    const projectDescription = getAgentToolDescription("custom");
    expect(projectDescription).toContain("project: - general:");
    expect(projectDescription).toContain("- explore:");
    expect(projectDescription).toContain(`@ ${globalDir}`);

    unlinkSync(projectTemplate);
    const globalDescription = getAgentToolDescription("custom");
    expect(globalDescription).toContain("global: - general:");
    expect(globalDescription).toContain("- explore:");

    unlinkSync(globalTemplate);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(getAgentToolDescription("custom")).toBe(getAgentToolDescription("full"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('toolDescriptionMode is "custom"'));
    warn.mockRestore();
  });
});
