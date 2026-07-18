import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { initTheme, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test, vi } from "vitest";
import registerTools from "./tools.js";

const tempDirectories: string[] = [];

async function captureEditTool() {
  let edit: any;
  registerTools({
    registerTool: vi.fn((tool) => {
      if (tool.name === "edit") edit = tool;
    }),
  } as any);
  return edit;
}

async function tempFile(content: string) {
  const directory = await mkdtemp(join(tmpdir(), "pi-bites-edit-"));
  tempDirectories.push(directory);
  const path = join(directory, "target.txt");
  await writeFile(path, content);
  return path;
}

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

async function execute(
  tool: any,
  path: string,
  old_string: string,
  new_string: string,
  replace_all?: boolean,
) {
  return tool.execute(
    crypto.randomUUID(),
    { path, old_string, new_string, ...(replace_all === undefined ? {} : { replace_all }) },
    undefined,
    undefined,
    {},
  );
}

describe("edit tool", () => {
  test("registers the single-replacement contract and performs an exact edit", async () => {
    const tool = await captureEditTool();
    const path = await tempFile("alpha\nbeta\n");

    expect(Object.keys(tool.parameters.properties)).toEqual([
      "path",
      "old_string",
      "new_string",
      "replace_all",
    ]);
    expect(tool.parameters.required).toEqual(["path", "old_string", "new_string"]);
    expect(tool.parameters.properties).not.toHaveProperty("edits");

    const result = await execute(tool, path, "beta", "gamma");

    expect(await readFile(path, "utf8")).toBe("alpha\ngamma\n");
    expect(result.details.matchTier).toBe("exact");
    expect(result.details.diff).toContain("-2 beta");
    expect(result.details.diff).toContain("+2 gamma");
  });

  test("rejects ambiguous matches by default and replaces all when requested", async () => {
    const tool = await captureEditTool();
    const path = await tempFile("old old old\n");

    await expect(execute(tool, path, "old", "new")).rejects.toThrow("Found 3 matches");
    expect(await readFile(path, "utf8")).toBe("old old old\n");

    const result = await execute(tool, path, "old", "new", true);
    expect(await readFile(path, "utf8")).toBe("new new new\n");
    expect(result.content[0].text).toContain("replaced 3 occurrence(s)");
  });

  test("uses whitespace and Unicode normalization while preserving surrounding bytes", async () => {
    const tool = await captureEditTool();
    const path = await tempFile("before  \nconst label = “old”;  \nafter\t\n");

    const result = await execute(tool, path, 'const label = "old";', 'const label = "new";');

    expect(await readFile(path, "utf8")).toBe('before  \nconst label = "new";  \nafter\t\n');
    expect(result.details.matchTier).toBe("whitespace-unicode");
    expect(result.content[0].text).toContain("Used whitespace-unicode matching");
  });

  test("replaces every match at a fuzzy tier", async () => {
    const tool = await captureEditTool();
    const path = await tempFile("first  \nsecond\nfirst\t\nsecond\n");

    const result = await execute(tool, path, "first\nsecond", "done", true);

    expect(await readFile(path, "utf8")).toBe("done\ndone\n");
    expect(result.details.matchTier).toBe("whitespace-unicode");
  });

  test("falls back to indentation-tolerant per-line matching", async () => {
    const tool = await captureEditTool();
    const path = await tempFile("  first\n\tsecond\nkeep\n");

    const result = await execute(tool, path, "first\nsecond", "changed\nblock");

    expect(await readFile(path, "utf8")).toBe("changed\nblock\nkeep\n");
    expect(result.details.matchTier).toBe("indentation");
  });

  test("uses the first matching tier and detects fuzzy ambiguity", async () => {
    const tool = await captureEditTool();
    const exactPath = await tempFile('"x"\n“x”\n');

    const exact = await execute(tool, exactPath, '"x"', '"y"');
    expect(await readFile(exactPath, "utf8")).toBe('"y"\n“x”\n');
    expect(exact.details.matchTier).toBe("exact");

    const ambiguousPath = await tempFile("“x”\n”x”\n");
    await expect(execute(tool, ambiguousPath, '"x"', '"y"')).rejects.toThrow("Found 2 matches");
    expect(await readFile(ambiguousPath, "utf8")).toBe("“x”\n”x”\n");
  });

  test("rejects missing, empty, and no-op replacements without changing the file", async () => {
    const tool = await captureEditTool();
    const path = await tempFile("same\n");

    await expect(execute(tool, path, "missing", "new")).rejects.toThrow(
      "Could not find old_string",
    );
    await expect(execute(tool, path, "", "new")).rejects.toThrow("old_string must not be empty");
    await expect(execute(tool, path, "same", "same")).rejects.toThrow("No changes made");
    await expect(execute(tool, path, "missing", "new", true)).rejects.toThrow(
      "Could not find old_string",
    );
    expect(await readFile(path, "utf8")).toBe("same\n");
  });

  test("does not invent indentation matches at end of file", async () => {
    const tool = await captureEditTool();
    const noNewline = await tempFile("foo");

    await expect(execute(tool, noNewline, "foo\n", "bar")).rejects.toThrow(
      "Could not find old_string",
    );
    expect(await readFile(noNewline, "utf8")).toBe("foo");

    const trailingNewline = await tempFile("abc\n");
    await expect(execute(tool, trailingNewline, " ", "x")).rejects.toThrow(
      "Could not find old_string",
    );
    expect(await readFile(trailingNewline, "utf8")).toBe("abc\n");
  });

  test("supports CRLF input and rejects nonexistent files", async () => {
    const tool = await captureEditTool();
    const path = await tempFile("one\r\ntwo\r\n");

    await execute(tool, path, "one\ntwo", "three\nfour");
    expect(await readFile(path, "utf8")).toBe("three\r\nfour\r\n");

    await expect(execute(tool, `${path}.missing`, "x", "y")).rejects.toThrow("Could not edit file");
  });

  test("rejects a stale plan when another queued mutation changes the file", async () => {
    const tool = await captureEditTool();
    const path = await tempFile("foo  \n");
    let release = () => {};
    let locked = () => {};
    const acquired = new Promise<void>((resolve) => (locked = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    const holding = withFileMutationQueue(path, async () => {
      locked();
      await gate;
    });
    await acquired;

    const editing = expect(execute(tool, path, "foo", "bar")).rejects.toThrow("the file changed");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeFile(path, "foo\t\n");
    release();
    await holding;

    await editing;
    expect(await readFile(path, "utf8")).toBe("foo\t\n");
  });

  test("supports project-relative paths and leading at-sign path references", async () => {
    const tool = await captureEditTool();
    const path = await tempFile("old\n");
    const relativePath = relative(process.cwd(), path);

    await execute(tool, relativePath, "old", "middle");
    await execute(tool, `@${relativePath}`, "middle", "new");

    expect(await readFile(path, "utf8")).toBe("new\n");
  });

  test("renders the target path and resulting diff", async () => {
    initTheme("dark", false);
    const tool = await captureEditTool();
    const path = await tempFile("old\n");
    const args = { path, old_string: "old", new_string: "new" };
    const context = {
      args,
      toolCallId: "render-call",
      invalidate: vi.fn(),
      lastComponent: undefined,
      state: {},
      cwd: process.cwd(),
      executionStarted: true,
      argsComplete: true,
      isPartial: false,
      expanded: false,
      showImages: false,
      isError: false,
    };
    const theme = {
      fg: (_color: string, text: string) => text,
      bg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    };

    const call = tool.renderCall(args, theme, context);
    expect(call.render(200).join("\n")).toContain(path);

    await vi.waitFor(() => expect(context.invalidate).toHaveBeenCalledTimes(1));
    tool.renderCall(args, theme, context);
    await vi.waitFor(() => expect(context.invalidate).toHaveBeenCalledTimes(2));
    tool.renderCall(args, theme, context);
    expect(call.render(200).join("\n")).toContain("-1 old");
    expect(call.render(200).join("\n")).toContain("+1 new");
    expect(await readFile(path, "utf8")).toBe("old\n");

    const result = await execute(tool, path, "old", "new");
    tool.renderResult(result, { expanded: false, isPartial: false }, theme, context);
    expect(call.render(200).join("\n")).toContain("-1 old");
    expect(call.render(200).join("\n")).toContain("+1 new");

    const missingArgs = { ...args, old_string: "missing" };
    context.args = missingArgs;
    tool.renderCall(missingArgs, theme, context);
    await vi.waitFor(() => expect(context.invalidate).toHaveBeenCalledTimes(3));
    tool.renderCall(missingArgs, theme, context);
    await vi.waitFor(() => expect(context.invalidate).toHaveBeenCalledTimes(4));
    tool.renderCall(missingArgs, theme, context);
    expect(call.render(200).join("\n")).toContain("Could not find the exact text");
  });

  test("guidance tells agents to read first and use replace_all intentionally", async () => {
    const tool = await captureEditTool();
    const guidance = tool.promptGuidelines.join(" ");

    expect(guidance).toContain("Read a target file before using edit");
    expect(guidance).toContain("Preserve exact whitespace and indentation");
    expect(guidance).toContain("replace_all only when every occurrence should change");
  });
});
