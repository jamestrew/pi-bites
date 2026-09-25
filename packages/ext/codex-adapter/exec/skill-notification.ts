import { basename, dirname } from "node:path";
import { extractBashFacts } from "../../bash-gate/bash-command-facts.js";
import { sanitizeSingleLine } from "../../subagents/ui/text-lines.js";

// Recognize reader operands only; unsupported options are ordinary exec activity.
function readerFiles(argv: string[]): string[] {
  const [reader, ...args] = argv;
  if (reader !== "cat" && reader !== "sed") return [];
  let options = true;
  let quiet = false;
  let script = false;
  const files: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (options && arg === "--") {
      options = false;
    } else if (options && arg.startsWith("-") && arg !== "-") {
      if (reader === "cat") {
        if (!/^-[benstvAETuv]+$/.test(arg)) return [];
      } else if (arg === "-n") {
        quiet = true;
      } else if (arg === "-e" || arg === "--expression") {
        if (++i >= args.length) return [];
        script = true;
      } else if (arg.startsWith("-e") || arg.startsWith("--expression=")) {
        script = true;
      } else {
        return [];
      }
    } else if (reader === "sed" && !script) {
      script = true;
    } else {
      files.push(arg);
    }
  }
  return reader === "sed" && !quiet ? [] : files;
}

/** Best-effort display metadata, never a prerequisite for launching the shell. */
export async function notifySkillReads(
  command: string,
  notify: (message: string, type: "info") => void,
): Promise<void> {
  try {
    const facts = await extractBashFacts(command);
    const skills = new Set<string>();
    for (const { argv } of facts.commands) {
      for (const path of readerFiles(argv)) {
        if (path.startsWith("-") || /[$`*?{}[\]\\~]/u.test(path)) continue;
        if (basename(path) !== "SKILL.md") continue;
        const name = basename(dirname(path));
        if (name && name !== ".") skills.add(sanitizeSingleLine(name));
      }
    }
    if (skills.size) notify(`[skill] ${[...skills].join(", ")}`, "info");
  } catch {
    // Parser and UI failures must not change command execution.
  }
}
