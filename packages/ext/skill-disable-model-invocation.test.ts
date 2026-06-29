import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { filterSkillsForModelInvocation } from "./skill-disable-model-invocation.js";
import type { Skill } from "@earendil-works/pi-coding-agent";

function skill(dir: string, name: string, frontmatter = ""): Skill {
  const filePath = join(dir, `${name}.md`);
  writeFileSync(filePath, `---\nname: ${name}\n${frontmatter}---\nbody`);
  return {
    name,
    description: `${name} desc`,
    filePath,
    baseDir: dir,
    sourceInfo: { source: "test", path: filePath, scope: "temporary", origin: "top-level" },
    disableModelInvocation: false,
  };
}

describe("filterSkillsForModelInvocation", () => {
  test("removes disabled skills from prompt but keeps other skills", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-bites-skill-"));
    const visible = skill(dir, "visible");
    const manual = skill(dir, "manual", "disable-model-invocation: true\n");
    const systemPrompt = `<available_skills>
  <skill>
    <name>visible</name>
    <description>visible desc</description>
    <location>${visible.filePath}</location>
  </skill>
  <skill>
    <name>manual</name>
    <description>manual desc</description>
    <location>${manual.filePath}</location>
  </skill>
</available_skills>`;

    const filtered = filterSkillsForModelInvocation(systemPrompt, [visible, manual]);

    expect(filtered.skills).toEqual([visible]);
    expect(filtered.systemPrompt).toContain("<name>visible</name>");
    expect(filtered.systemPrompt).not.toContain("<name>manual</name>");
  });

  test("ignores missing fallback skill files", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-bites-skill-"));
    const missing = skill(dir, "missing");
    rmSync(missing.filePath);

    expect(filterSkillsForModelInvocation("prompt", [missing])).toEqual({
      systemPrompt: "prompt",
      skills: [missing],
    });
  });
});
