import { visibleWidth } from "@earendil-works/pi-tui";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import registerCodegraph from "./codegraph.js";

async function load(
  exec = vi.fn().mockResolvedValue({ code: 0, stdout: "1.6", stderr: "", killed: false }),
) {
  const registerTool = vi.fn();
  await registerCodegraph({ exec, registerTool } as unknown as ExtensionAPI);
  return { exec, registerTool, tool: registerTool.mock.calls[0]?.[0] as ToolDefinition };
}

describe("CodeGraph CLI registration", () => {
  test.each([
    new Error("ENOENT"),
    new Error("EACCES"),
    { code: 1, stdout: "", stderr: "failed", killed: false },
  ])("is inert when version detection fails: %s", async (failure) => {
    const exec = vi.fn();
    if (failure instanceof Error) exec.mockRejectedValue(failure);
    else exec.mockResolvedValue(failure);
    const loaded = await load(exec);
    expect(loaded.registerTool).not.toHaveBeenCalled();
    expect(exec).toHaveBeenCalledWith("codegraph", ["--version"], expect.any(Object));
  });
  test("registers exactly one tool when usable", async () => {
    const loaded = await load();
    expect(loaded.registerTool).toHaveBeenCalledTimes(1);
    expect(loaded.tool.name).toBe("codegraph_explore");
  });
});

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function project(indexed = true) {
  const root = mkdtempSync(join(tmpdir(), "codegraph-test-"));
  dirs.push(root);
  if (indexed) mkdirSync(join(root, ".codegraph"));
  mkdirSync(join(root, "src"));
  return root;
}
function call(
  tool: ToolDefinition,
  cwd: string,
  query = "-literal --path elsewhere",
  maxFiles?: number,
  signal?: AbortSignal,
) {
  return tool.execute(
    "id",
    { query, ...(maxFiles === undefined ? {} : { maxFiles }) },
    signal,
    undefined,
    { cwd } as never,
  );
}
test("pins nested calls to the nearest index, syncing every time before literal exploration", async () => {
  const outer = project();
  const root = join(outer, "src");
  mkdirSync(join(root, ".codegraph"));
  const cwd = join(root, "nested");
  mkdirSync(cwd);
  const source = join(root, "source.ts");
  writeFileSync(source, "first version");
  let indexed = "";
  const loaded = await load();
  loaded.exec.mockImplementation(async (_cmd, args) => {
    if (args[0] === "sync") indexed = readFileSync(source, "utf8");
    return { code: 0, stdout: args[0] === "sync" ? "synced" : indexed, stderr: "", killed: false };
  });
  const signal = new AbortController().signal;
  expect((await call(loaded.tool, cwd, undefined, 3, signal)).content).toEqual([
    { type: "text", text: "first version" },
  ]);
  writeFileSync(source, "edited version");
  expect((await call(loaded.tool, cwd)).content).toEqual([
    { type: "text", text: "edited version" },
  ]);
  expect(loaded.exec.mock.calls.slice(1)).toEqual([
    ["codegraph", ["sync", root], { cwd: root, signal }],
    [
      "codegraph",
      [
        "--no-color",
        "explore",
        "--path",
        root,
        "--max-files",
        "3",
        "--",
        "-literal --path elsewhere",
      ],
      { cwd: root, signal },
    ],
    ["codegraph", ["sync", root], { cwd: root, signal: undefined }],
    [
      "codegraph",
      ["--no-color", "explore", "--path", root, "--", "-literal --path elsewhere"],
      { cwd: root, signal: undefined },
    ],
  ]);
});
test("missing indexes give init guidance without running commands", async () => {
  const { tool, exec } = await load();
  await expect(call(tool, project(false))).rejects.toThrow("codegraph init");
  expect(exec).toHaveBeenCalledTimes(1);
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
test("serializes whole sequences per root, allows other roots, and never reuses stale ctx", async () => {
  const root = project();
  const other = project();
  const loaded = await load();
  const entered = deferred();
  const release = deferred();
  const commands: string[][] = [];
  loaded.exec.mockImplementation(async (_cmd, args) => {
    commands.push(args);
    if (commands.length === 1) {
      entered.resolve();
      await release.promise;
    }
    return { code: 0, stdout: "ok", stderr: "", killed: false };
  });
  let stale = false;
  const ctx = {
    get cwd() {
      if (stale) throw new Error("stale ctx");
      return root;
    },
  };
  const first = loaded.tool.execute("first", { query: "one" }, undefined, undefined, ctx as never);
  await entered.promise;
  const second = loaded.tool.execute(
    "second",
    { query: "two" },
    undefined,
    undefined,
    ctx as never,
  );
  stale = true;
  await call(loaded.tool, other, "other");
  expect(commands).toEqual([
    ["sync", root],
    ["sync", other],
    ["--no-color", "explore", "--path", other, "--", "other"],
  ]);
  release.resolve();
  await Promise.all([first, second]);
  expect(commands.slice(3)).toEqual([
    ["--no-color", "explore", "--path", root, "--", "one"],
    ["sync", root],
    ["--no-color", "explore", "--path", root, "--", "two"],
  ]);
});

test.each(["sync", "explore"])(
  "%s errors throw and release the root for the next call",
  async (stage) => {
    const root = project();
    const loaded = await load();
    loaded.exec.mockImplementation(async (_cmd, args) => ({
      code: args.includes(stage) ? 2 : 0,
      stdout: "",
      stderr: "broken index",
      killed: false,
    }));
    await expect(call(loaded.tool, root)).rejects.toThrow("broken index");
    if (stage === "sync") expect(loaded.exec).toHaveBeenCalledTimes(2);
    loaded.exec.mockResolvedValue({ code: 0, stdout: "recovered", stderr: "", killed: false });
    expect((await call(loaded.tool, root)).content).toEqual([{ type: "text", text: "recovered" }]);
  },
);

test("aborted calls cannot start exploration or poison subsequent calls", async () => {
  const root = project();
  const loaded = await load();
  const controller = new AbortController();
  loaded.exec.mockImplementation(async () => {
    controller.abort();
    return { code: 0, stdout: "", stderr: "", killed: false };
  });
  await expect(call(loaded.tool, root, "q", undefined, controller.signal)).rejects.toThrow();
  expect(loaded.exec).toHaveBeenCalledTimes(2);
  await expect(call(loaded.tool, root, "q", undefined, controller.signal)).rejects.toThrow();
  expect(loaded.exec).toHaveBeenCalledTimes(2);
});

test.each(["line", "byte"])("bounds %s-heavy stdout and preserves full output", async (limit) => {
  const { tool, exec } = await load();
  const output = limit === "line" ? "source\n".repeat(2100) : "x".repeat(60000);
  exec.mockResolvedValue({ code: 0, stdout: output, stderr: "", killed: false });
  const result = await call(tool, project());
  const text = (result.content[0] as { text: string }).text;
  expect(Buffer.byteLength(text)).toBeLessThan(52000);
  expect(text.split("\n").length).toBeLessThan(2010);
  const path = text.match(/Full output: (.+)\]/)?.[1];
  expect(path).toBeTruthy();
  if (path) {
    dirs.push(join(path, ".."));
    expect(readFileSync(path, "utf8")).toBe(output);
  }
});

test("renders the query scanline and exec-style collapsed, expanded, and error output", async () => {
  const { tool } = await load();
  const theme = {
    bold: (text: string) => `<bold>${text}</bold>`,
    fg: (role: string, text: string) => `<${role}>${text}</${role}>`,
  };
  const context = { state: {}, executionStarted: true, isError: false };
  const callRow = tool.renderCall!(
    { query: "find callers", maxFiles: 4 },
    theme as never,
    context as never,
  );
  expect(callRow.render(200).map((line) => line.trimEnd())).toEqual([
    "<bold>codegraph_explore</bold><toolTitle> find callers (max 4 files)</toolTitle>",
  ]);
  const text = Array.from({ length: 10 }, (_, i) => `source ${i + 1}`).join("\n");
  const result = {
    content: [{ type: "text" as const, text }],
    details: { output: text, wall_time_seconds: 1.25 },
  };
  const render = (expanded: boolean, isPartial = false) =>
    tool.renderResult!(result, { expanded, isPartial }, theme as never, context as never)
      .render(200)
      .map((line) => line.trimEnd());
  const collapsed = render(false);
  expect(collapsed[0]).toBe("");
  expect(collapsed.join("\n")).not.toContain("source 5");
  expect(collapsed.join("\n")).toContain("<dim>source 10</dim>");
  expect(collapsed.at(-2)).toContain("Took 1.3s");
  expect(collapsed.at(-1)).toContain("to expand");
  expect(render(true).join("\n")).toContain("<dim>source 1</dim>");
  expect(render(true).join("\n")).not.toContain("to expand");
  expect(render(false, true).join("\n")).toContain("Elapsed 1.3s");
  const error = tool.renderResult!(
    { content: [{ type: "text", text: "broken index" }], details: undefined },
    { expanded: false, isPartial: false },
    theme as never,
    { state: {}, isError: true } as never,
  )
    .render(200)
    .join("\n");
  expect(error).toContain("<dim>broken index</dim>");
  const plain = { bold: (s: string) => s, fg: (_r: string, s: string) => s };
  for (const expanded of [false, true]) {
    const lines = [
      ...tool.renderCall!(
        { query: "long query ".repeat(30) },
        plain as never,
        { state: {} } as never,
      ).render(24),
      ...tool.renderResult!(
        result,
        { expanded, isPartial: false },
        plain as never,
        { state: {} } as never,
      ).render(24),
    ];
    expect(lines.every((line) => visibleWidth(line) <= 24)).toBe(true);
  }
});

test("killed subprocesses throw even when their exit code is zero", async () => {
  const { tool, exec } = await load();
  exec.mockResolvedValue({ code: 0, stdout: "partial", stderr: "", killed: true });
  await expect(call(tool, project())).rejects.toThrow("CodeGraph failed");
  expect(exec).toHaveBeenCalledTimes(2);
});
