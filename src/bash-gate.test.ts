import { describe, expect, test } from "bun:test";
import { extractBashFacts } from "./bash-command-facts.js";
import { DESTRUCTIVE_MATCH_LABELS, findMatchedPattern } from "./bash-gate.js";

describe("extractBashFacts", () => {
  test("extracts commands, redirects, path-ish args, and pipe presence", async () => {
    const facts = await extractBashFacts("git push origin main > out.txt | tee ./log.txt");

    expect(facts.hasPipe).toBe(true);
    expect(facts.commands.map((command) => command.argv)).toEqual([
      ["git", "push", "origin", "main"],
      ["tee", "./log.txt"],
    ]);
    expect(facts.redirects).toContainEqual({ operator: ">", target: "out.txt" });
    expect(facts.pathCandidates).toContain("./log.txt");
  });
});

describe("findMatchedPattern", () => {
  test.each([
    "rg foo . 2>&1",
    "rg foo . 1>&2",
    "rg foo . 2>/dev/null",
    "rg foo . >/dev/null",
    "rg foo . >>/dev/null",
    "make build >/dev/null 2>&1",
    "python3 scripts/planner.py lisst --mode all | rg 'block-big-tables|sync-servers-code-refactor' -n -C 2",
    "printf '%s\n' code-refactor",
  ])("allows safe redirect case: %s", async (command: string) => {
    expect(await findMatchedPattern(command)).toBeUndefined();
  });

  test.each([
    ["echo hi > out.txt", "redirect:>"],
    ["cat < in.txt > out.txt", "redirect:>"],
    ["make build >/tmp/build.log 2>&1", "redirect:>"],
    ["echo hi >> out.txt", "redirect:>>"],
    ["rm -rf tmp", "rm"],
    ["git push origin main", "git push"],
    ["git branch -D old-branch", "git branch -d"],
    ["bun add zod", "bun add"],
    ["service nginx restart", "service restart"],
  ])("matches a destructive pattern for: %s", async (command: string, label: string) => {
    const matched = await findMatchedPattern(command);

    expect(matched).toBeDefined();
    expect(matched?.label).toBe(label);
    expect(DESTRUCTIVE_MATCH_LABELS).toContain(label);
  });

  test("supports configured extra patterns", async () => {
    const matched = await findMatchedPattern("bun test", {
      bashGate: { patterns: ["\\bbun\\s+test\\b"] },
    });

    expect(matched?.label).toBe("\\bbun\\s+test\\b");
    expect(matched?.source).toBe("configured");
  });
});
