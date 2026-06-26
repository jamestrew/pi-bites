import { describe, expect, test } from "vitest";
import { extractBashFacts } from "./bash-command-facts.js";
import { findMatchedPattern, findMatchedPatterns } from "./index.js";

describe("extractBashFacts", () => {
  test("extracts commands, redirects, path-ish args, pipe presence, and flags", async () => {
    const facts = await extractBashFacts("git push origin main > out.txt | tee ./log.txt");

    expect(facts.hasPipe).toBe(true);
    expect(facts.commands.map((command) => command.argv)).toEqual([
      ["git", "push", "origin", "main"],
      ["tee", "./log.txt"],
    ]);
    expect(facts.commands[0]?.flags).toEqual([]);
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
  });

  test("matches every gated command in a compound command", async () => {
    const matches = await findMatchedPatterns("chmod +x foo && rm bar");

    expect(matches.map((match) => match.label)).toEqual(expect.arrayContaining(["chmod", "rm"]));
  });

  test("matches every gated command separated by semicolons", async () => {
    const matches = await findMatchedPatterns("rmdir a; rm b");

    expect(matches.map((match) => match.label)).toEqual(["rmdir", "rm"]);
  });

  test("supports configured command-only rules", async () => {
    const matched = await findMatchedPattern("pytest -q", {
      bashGate: { rules: [{ cmd: "pytest" }] },
    });

    expect(matched?.label).toBe("pytest");
    expect(matched?.source).toBe("configured");
  });

  test("supports configured subcommand rules", async () => {
    const matched = await findMatchedPattern("git push origin main", {
      bashGate: {
        rules: [{ cmd: "git", subcommands: ["push"], reason: "push mutates remote state" }],
      },
    });

    expect(matched?.label).toBe("git push");
    expect(matched?.reason).toBe("push mutates remote state");
  });

  test("supports configured flagAny rules", async () => {
    const matched = await findMatchedPattern("sed -i 's/a/b/' file.txt", {
      bashGate: { rules: [{ cmd: "sed", flagAny: ["-i"] }] },
    });

    expect(matched?.label).toBe("sed -i");
    expect(matched?.source).toBe("configured");
  });

  test("supports configured redirect rules", async () => {
    const matched = await findMatchedPattern("echo hi >> out.txt", {
      bashGate: { rules: [{ redirects: "append" }] },
    });

    expect(matched?.label).toBe("redirect:>>");
    expect(matched?.source).toBe("configured");
  });

  test("configured rules extend builtin defaults", async () => {
    const builtinMatch = await findMatchedPattern("git push origin main", {
      bashGate: { rules: [{ cmd: "sed", flagAny: ["-i"] }] },
    });
    const configuredMatch = await findMatchedPattern("sed -i 's/a/b/' file.txt", {
      bashGate: { rules: [{ cmd: "sed", flagAny: ["-i"] }] },
    });

    expect(builtinMatch?.label).toBe("git push");
    expect(builtinMatch?.source).toBe("builtin");
    expect(configuredMatch?.label).toBe("sed -i");
    expect(configuredMatch?.source).toBe("configured");
  });
});
