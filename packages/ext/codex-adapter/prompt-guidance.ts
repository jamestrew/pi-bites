import { formatSkillsForPrompt, type Skill } from "@earendil-works/pi-coding-agent";

const TOOL_GUIDANCE: Readonly<Record<string, string>> = {
  exec_command:
    "- `exec_command`: Commands can yield before completion. A yielded command returns a `session_id`; use it to resume that session instead of restarting the command.",
  write_stdin:
    "- `write_stdin`: Pass a `session_id`; omit `chars` to poll and continue waiting, send characters for interactive input, or send `\\u0003` to interrupt. Reuse it until the session completes.",
  apply_patch:
    "- `apply_patch`: Pass one patch bounded by `*** Begin Patch` and `*** End Patch`. Use `*** Add File:`, `*** Update File:`, or `*** Delete File:` sections (and optional `*** Move to:`); prefix added, removed, and context lines with `+`, `-`, and a space.",
  web_run:
    "- `web_run`: Search, open, click, or find with explicit arguments. Reuse returned reference IDs only in later `web_run` navigation calls.",
};

export function buildToolGuidance(activeTools: string[]): string | undefined {
  const guidance = activeTools.flatMap((name) => {
    const line = TOOL_GUIDANCE[name];
    return line === undefined ? [] : [line];
  });
  if (guidance.length === 0) return;

  return `<pi-bites-tool-guidance>\n## Structured tool guidance\n\n${guidance.join("\n")}\n</pi-bites-tool-guidance>`;
}

export function buildExecSkillGuidance(skills: Skill[], activeTools: string[]): string | undefined {
  if (!activeTools.includes("exec_command") || activeTools.includes("read")) return;
  const guidance = formatSkillsForPrompt(skills);
  if (!guidance) return;
  const adapted = guidance.replace(
    "Use the read tool to load a skill's file",
    "Use `exec_command` to load a skill's file",
  );
  if (adapted === guidance)
    throw new Error("Pi skill prompt format changed; cannot adapt read tool");
  return adapted;
}
