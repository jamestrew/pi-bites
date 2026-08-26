import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test, vi } from "vitest";
import registerAtMentionContext, { expandMention, parseAtMentions } from "./index.js";

const fixtureDirs: string[] = [];

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "pi-bites-at-mention-"));
  fixtureDirs.push(dir);
  await writeFile(join(dir, "foo.ts"), "one\ntwo\nthree\nfour\nfive\n");
  await writeFile(join(dir, "foo.ts:12"), "literal suffix file\n");
  await writeFile(join(dir, "foo bar.ts"), "alpha\nbeta\ngamma\n");
  return dir;
}

afterEach(async () => {
  await Promise.all(fixtureDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function extensionHarness(cwd: string) {
  const handlers = new Map<string, (event: any, ctx: any) => any>();
  const sendMessage = vi.fn();
  const notify = vi.fn();
  const pi = {
    on: (event: string, handler: (event: any, ctx: any) => any) => handlers.set(event, handler),
    sendMessage,
  };
  const ctx = { cwd, signal: undefined, ui: { notify } };
  registerAtMentionContext(pi as never);

  return {
    notify,
    sendMessage,
    input: (text: string, context: any = ctx) =>
      handlers.get("input")!({ source: "interactive", text }, context),
    compact: () => handlers.get("session_compact")!({}, ctx),
    navigateTree: () => handlers.get("session_tree")!({}, ctx),
  };
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

describe("at-mention context lifecycle", () => {
  test("injects and notifies again only when model-visible file content changes", async () => {
    const dir = await fixture();
    const { input, notify, sendMessage } = extensionHarness(dir);

    await input("inspect @foo.ts");
    await input("inspect @foo.ts again");
    await utimes(join(dir, "foo.ts"), new Date(), new Date());
    await input("inspect @foo.ts after a metadata-only change");

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith("Injected at-mention context: @foo.ts", "info");

    await writeFile(join(dir, "foo.ts"), "changed\n");
    await input("inspect @foo.ts after an edit");

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls[1]?.[0].content).toContain("changed");
    expect(notify).toHaveBeenCalledTimes(2);
  });

  test("injects and reports only new expansions from a mixed prompt", async () => {
    const dir = await fixture();
    const { input, notify, sendMessage } = extensionHarness(dir);
    await input("inspect @foo.ts");

    await input('compare @foo.ts with @"foo bar.ts"');

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls[1]?.[0].content).not.toContain(
      `name="${resolve(dir, "foo.ts")}"`,
    );
    expect(sendMessage.mock.calls[1]?.[0].content).toContain(
      `name="${resolve(dir, "foo bar.ts")}"`,
    );
    expect(notify).toHaveBeenLastCalledWith('Injected at-mention context: @"foo bar.ts"', "info");
  });

  test("caches full-file and ranged expansions independently", async () => {
    const dir = await fixture();
    const { input, sendMessage } = extensionHarness(dir);

    await input("inspect @foo.ts");
    await input("inspect @foo.ts:2-3");
    await input("inspect @foo.ts:2-3 again");
    await input("inspect @foo.ts:3-4");

    expect(sendMessage).toHaveBeenCalledTimes(3);
  });

  test("successful compaction and tree navigation invalidate remembered expansions", async () => {
    const dir = await fixture();
    const { compact, input, navigateTree, sendMessage } = extensionHarness(dir);

    await input("inspect @foo.ts");
    await input("inspect @foo.ts again");
    compact();
    await input("inspect @foo.ts after compaction");
    navigateTree();
    await input("inspect @foo.ts after tree navigation");

    expect(sendMessage).toHaveBeenCalledTimes(3);
  });

  test("invalid mentions neither notify nor become remembered expansions", async () => {
    const dir = await fixture();
    const { input, notify, sendMessage } = extensionHarness(dir);

    await input("inspect @later.ts");
    await writeFile(join(dir, "later.ts"), "now present\n");
    await input("inspect @later.ts");

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledOnce();
  });

  test("does not dereference a stale extension context after expansion work starts", async () => {
    const dir = await fixture();
    const { input, notify } = extensionHarness(dir);
    const values = { cwd: dir, signal: undefined, ui: { notify } };
    let stale = false;
    const ctx: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(values)) {
      Object.defineProperty(ctx, key, {
        get: () => {
          if (stale) throw new Error("stale extension context");
          return value;
        },
      });
    }

    const handling = input("inspect @foo.ts", ctx);
    stale = true;

    await expect(handling).resolves.toEqual({ action: "continue" });
    expect(notify).toHaveBeenCalledWith("Injected at-mention context: @foo.ts", "info");
  });
});
