import { describe, expect, test } from "bun:test";
import { DESTRUCTIVE_PATTERNS, findMatchedPattern } from "./bash-gate.js";

describe("findMatchedPattern", () => {
  test.each([
    "rg foo . 2>&1",
    "rg foo . 1>&2",
    "rg foo . 2>/dev/null",
    "rg foo . >/dev/null",
    "rg foo . >>/dev/null",
    "make build >/dev/null 2>&1",
  ])("allows safe redirect case: %s", (command: string) => {
    expect(findMatchedPattern(command)).toBeUndefined();
  });

  test.each([
    "echo hi > out.txt",
    "cat < in.txt > out.txt",
    "make build >/tmp/build.log 2>&1",
    "echo hi >> out.txt",
    "rm -rf tmp",
    "git push origin main",
    "bun add zod",
  ])("matches a destructive pattern for: %s", (command: string) => {
    const matched = findMatchedPattern(command);

    expect(matched).toBeDefined();
    expect(DESTRUCTIVE_PATTERNS.includes(matched!)).toBe(true);
  });

  test("supports configured extra patterns", () => {
    const matched = findMatchedPattern("bun test", {
      bashGate: { patterns: ["\\bbun\\s+test\\b"] },
    });

    expect(matched?.source).toBe("\\bbun\\s+test\\b");
  });
});
