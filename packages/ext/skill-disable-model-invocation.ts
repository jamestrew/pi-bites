import { readFileSync } from "node:fs";
import { type ExtensionAPI, type Skill } from "@earendil-works/pi-coding-agent";

function hasDisabledFrontmatter(skill: Skill): boolean {
  if (skill.disableModelInvocation) return true;

  try {
    const frontmatter = readFileSync(skill.filePath, "utf-8").match(/^---\n([\s\S]*?)\n---/);
    return (
      frontmatter?.[1]
        ?.split("\n")
        .some((line) => /^disable-model-invocation:\s*true\s*$/.test(line.trim())) === true
    );
  } catch {
    return false;
  }
}

function stripSkillFromAvailableSkills(systemPrompt: string, skill: Skill): string {
  const availableSkills = systemPrompt.match(/<available_skills>[\s\S]*?<\/available_skills>/);
  if (!availableSkills) return systemPrompt;

  const escapedName = skill.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const entry = new RegExp(
    `\\n  <skill>\\n    <name>${escapedName}<\\/name>\\n[\\s\\S]*?\\n  <\\/skill>`,
    "g",
  );
  const nextBlock = availableSkills[0].replace(entry, "");
  return systemPrompt.replace(availableSkills[0], nextBlock);
}

export function filterSkillsForModelInvocation(systemPrompt: string, skills: Skill[] = []) {
  const disabled = skills.filter(hasDisabledFrontmatter);
  if (disabled.length === 0) return { systemPrompt, skills };

  const visibleSkills = skills.filter((skill) => !disabled.includes(skill));
  const filteredPrompt = disabled.reduce(stripSkillFromAvailableSkills, systemPrompt);
  return { systemPrompt: filteredPrompt, skills: visibleSkills };
}

export default function registerSkillDisableModelInvocation(pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event) => {
    const filtered = filterSkillsForModelInvocation(
      event.systemPrompt,
      event.systemPromptOptions.skills,
    );
    if (filtered.systemPrompt !== event.systemPrompt)
      return { systemPrompt: filtered.systemPrompt };
  });
}
