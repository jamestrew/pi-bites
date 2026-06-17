import { mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { expandMention, parseAtMentions } from "./at-mention-context.js";

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "pi-bites-at-mention-"));
  await writeFile(join(dir, "foo.ts"), "one\ntwo\nthree\nfour\nfive\n");
  await writeFile(join(dir, "foo.ts:12"), "literal suffix file\n");
  await writeFile(join(dir, "foo bar.ts"), "alpha\nbeta\ngamma\n");
  return dir;
}

describe("parseAtMentions", () => {
  test("keeps line suffixes on unquoted and quoted mentions", () => {
    expect(parseAtMentions('read @foo.ts:2-3 and @"foo bar.ts:2"')).toEqual([
      { raw: "@foo.ts:2-3", path: "foo.ts:2-3" },
      { raw: '@"foo bar.ts:2"', path: "foo bar.ts:2" },
    ]);
  });

  test("keeps same file mentions with different line ranges", () => {
    expect(parseAtMentions("@foo.ts:1 @foo.ts:2 @foo.ts:1")).toEqual([
      { raw: "@foo.ts:1", path: "foo.ts:1" },
      { raw: "@foo.ts:2", path: "foo.ts:2" },
    ]);
  });
});

describe("expandMention", () => {
  test("reads from a start line", async () => {
    const dir = await fixture();

    const expansion = await expandMention(dir, { raw: "@foo.ts:3", path: "foo.ts:3" });

    expect(expansion?.absolutePath).toBe(resolve(dir, "foo.ts"));
    expect(expansion?.mention.path).toBe("foo.ts");
    expect(expansion?.mention.lineRange).toEqual({ start: 3, end: undefined });
    expect(expansion?.text).toContain("three");
    expect(expansion?.text).not.toContain("two");
  });

  test("reads an inclusive line range", async () => {
    const dir = await fixture();

    const expansion = await expandMention(dir, { raw: "@foo.ts:2-3", path: "foo.ts:2-3" });

    expect(expansion?.mention.lineRange).toEqual({ start: 2, end: 3 });
    expect(expansion?.text).toContain("two");
    expect(expansion?.text).toContain("three");
    expect(expansion?.text).not.toContain("four");
  });

  test("supports quoted paths with spaces and line suffixes", async () => {
    const dir = await fixture();

    const expansion = await expandMention(dir, {
      raw: '@"foo bar.ts:2"',
      path: "foo bar.ts:2",
    });

    expect(expansion?.absolutePath).toBe(resolve(dir, "foo bar.ts"));
    expect(expansion?.text).toContain("beta");
    expect(expansion?.text).not.toContain("alpha");
  });

  test("treats exact files with suffix-looking names as exact paths", async () => {
    const dir = await fixture();

    const expansion = await expandMention(dir, { raw: "@foo.ts:12", path: "foo.ts:12" });

    expect(expansion?.absolutePath).toBe(resolve(dir, "foo.ts:12"));
    expect(expansion?.mention.lineRange).toBeUndefined();
    expect(expansion?.text).toContain("literal suffix file");
  });

  test("ignores invalid ranges and reads the base path", async () => {
    const dir = await fixture();

    const zero = await expandMention(dir, { raw: "@foo.ts:0", path: "foo.ts:0" });
    const descending = await expandMention(dir, { raw: "@foo.ts:3-2", path: "foo.ts:3-2" });

    expect(zero?.absolutePath).toBe(resolve(dir, "foo.ts"));
    expect(zero?.mention.lineRange).toBeUndefined();
    expect(zero?.text).toContain("one");
    expect(descending?.absolutePath).toBe(resolve(dir, "foo.ts"));
    expect(descending?.mention.lineRange).toBeUndefined();
    expect(descending?.text).toContain("one");
  });

  test("supports absolute paths with line suffixes", async () => {
    const dir = await fixture();
    const absolute = join(dir, "foo.ts");

    const expansion = await expandMention(dir, { raw: `@${absolute}:4`, path: `${absolute}:4` });

    expect(expansion?.absolutePath).toBe(absolute);
    expect(expansion?.text).toContain("four");
    expect(expansion?.text).not.toContain("three");
  });
});
