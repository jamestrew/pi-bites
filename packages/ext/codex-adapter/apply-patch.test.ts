import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test, vi } from "vitest";

import { getBundledApplyPatchBinaryPath } from "./apply-patch/binary.js";
import { executePatchWithRust } from "./apply-patch/executor.js";
import { clearApplyPatchRenderState } from "./apply-patch/render-state.js";
import { createApplyPatchTool, registerApplyPatchTool } from "./apply-patch/tool.js";

const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-bites-apply-patch-"));
  dirs.push(dir);
  return dir;
};

const patch = (...lines: string[]) => ["*** Begin Patch", ...lines, "*** End Patch"].join("\n");

async function execute(cwd: string, input: string, signal?: AbortSignal) {
  return createApplyPatchTool().execute("call", { input }, signal, undefined, { cwd } as never);
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("apply_patch", () => {
  test("adds, updates, moves, and deletes files through the structured contract", async () => {
    const cwd = tempDir();

    const added = await execute(cwd, patch("*** Add File: a.txt", "+one"));
    expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("one\n");
    expect(added.details).toMatchObject({
      status: "success",
      result: { createdFiles: ["a.txt"], fuzz: 0 },
    });

    const absolute = join(cwd, "absolute.txt");
    await execute(cwd, patch(`*** Add File: ${absolute}`, "+absolute"));
    expect(readFileSync(absolute, "utf8")).toBe("absolute\n");

    await execute(cwd, patch("*** Update File: a.txt", "@@", "-one", "+two"));
    expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("two\n");

    const moved = await execute(
      cwd,
      patch("*** Update File: a.txt", "*** Move to: b.txt", "@@", " two"),
    );
    expect(existsSync(join(cwd, "a.txt"))).toBe(false);
    expect(readFileSync(join(cwd, "b.txt"), "utf8")).toBe("two\n");
    expect(moved.details).toMatchObject({
      status: "success",
      result: { movedFiles: ["a.txt -> b.txt"] },
    });

    await execute(cwd, patch("*** Delete File: b.txt"));
    expect(existsSync(join(cwd, "b.txt"))).toBe(false);
  });

  test("renders the upstream diff preview without a duplicate result summary", async () => {
    const cwd = tempDir();
    writeFileSync(join(cwd, "sample.txt"), "one\ntwo\nthree\n");
    const input = patch("*** Update File: sample.txt", "@@", " one", "-two", "+TWO", " three");
    const tool = createApplyPatchTool();
    const result = await tool.execute("render", { input }, undefined, undefined, { cwd } as never);
    const theme = {
      fg: (_role: string, text: string) => text,
      bold: (text: string) => text,
    };
    const context = {
      toolCallId: "render",
      cwd,
      argsComplete: true,
      expanded: false,
      state: {},
      invalidate: vi.fn(),
    };

    const collapsed = stripVTControlCharacters(
      tool.renderCall!({ input }, theme as never, context as never)
        .render(200)
        .join("\n"),
    );
    expect(collapsed.split("\n").map((line) => line.trimEnd())).toEqual([
      "Edited sample.txt (+1 -1)",
      "1  one",
      "2 -two",
      "2 +TWO",
      "3  three",
    ]);

    expect(
      tool.renderResult!(
        result,
        { expanded: false, isPartial: false },
        theme as never,
        context as never,
      ).render(200),
    ).toEqual([]);

    const longInput = patch(
      "*** Add File: long.txt",
      ...Array.from({ length: 14 }, (_, index) => `+line ${index + 1}`),
    );
    const longTool = createApplyPatchTool();
    await longTool.execute("long-render", { input: longInput }, undefined, undefined, {
      cwd,
    } as never);
    const renderLong = (expanded: boolean) =>
      stripVTControlCharacters(
        longTool.renderCall!(
          { input: longInput },
          theme as never,
          {
            ...context,
            toolCallId: "long-render",
            expanded,
            state: {},
            invalidate: vi.fn(),
          } as never,
        )
          .render(200)
          .join("\n"),
      );

    expect(renderLong(false)).toContain("more lines");
    expect(renderLong(true)).not.toContain("more lines");
    expect(renderLong(true)).toContain("14 +line 14");
  });

  test("shows action-first targets while patch arguments stream", () => {
    const rendered = createApplyPatchTool().renderCall!(
      {
        input: [
          "*** Begin Patch",
          "*** Update File: one.txt",
          "*** Add File: two.txt",
          "*** Delete File: three.txt",
        ].join("\n"),
      },
      { fg: (_role: string, text: string) => text, bold: (text: string) => text } as never,
      { argsComplete: false, state: {} } as never,
    )
      .render(200)
      .map((line) => line.trimEnd());

    expect(rendered).toEqual(["Edit one.txt", "Add two.txt", "Delete three.txt"]);
  });

  test("restores completed previews from persisted result details", async () => {
    const cwd = tempDir();
    writeFileSync(join(cwd, "deleted.txt"), "first\nsecond\n");
    const input = patch("*** Delete File: deleted.txt");
    const tool = createApplyPatchTool();
    const result = await tool.execute("persisted-render", { input }, undefined, undefined, {
      cwd,
    } as never);
    clearApplyPatchRenderState();
    const theme = {
      fg: (_role: string, text: string) => text,
      bold: (text: string) => text,
    };
    const context = {
      toolCallId: "persisted-render",
      cwd,
      argsComplete: true,
      expanded: false,
      state: {},
      invalidate: vi.fn(),
    };

    tool.renderResult!(
      result,
      { expanded: false, isPartial: false },
      theme as never,
      context as never,
    );
    const restored = stripVTControlCharacters(
      tool.renderCall!({ input }, theme as never, context as never)
        .render(200)
        .join("\n"),
    );

    expect(context.invalidate).toHaveBeenCalledOnce();
    expect(restored).toContain("Deleted deleted.txt (+0 -2)");
    expect(restored).toContain("1 -first");
    expect(restored).toContain("2 -second");
  });

  test("renders repeated targets as one sequential file preview", async () => {
    const cwd = tempDir();
    writeFileSync(join(cwd, "repeated.txt"), "one\ntwo\n");
    const input = patch(
      "*** Update File: repeated.txt",
      "@@",
      "+zero",
      " one",
      "*** Update File: repeated.txt",
      "@@",
      " two",
      "+three",
    );
    const tool = createApplyPatchTool();
    await tool.execute("repeated-render", { input }, undefined, undefined, { cwd } as never);
    const rendered = stripVTControlCharacters(
      tool.renderCall!(
        { input },
        { fg: (_role: string, text: string) => text, bold: (text: string) => text } as never,
        {
          toolCallId: "repeated-render",
          cwd,
          argsComplete: true,
          expanded: true,
          state: {},
        } as never,
      )
        .render(200)
        .join("\n"),
    );

    expect(rendered).toContain("Edited repeated.txt (+2 -0)");
    expect(rendered).toContain("3  two");
    expect(rendered).toContain("4 +three");
    expect(rendered).not.toContain("2 files");
  });

  test("renders insertion-only seek hunks at the native end-of-file location", async () => {
    const cwd = tempDir();
    writeFileSync(join(cwd, "seek.txt"), "one\ntwo\nthree\n");
    const input = patch("*** Update File: seek.txt", "@@ two", "+inserted");
    const tool = createApplyPatchTool();
    await tool.execute("seek-render", { input }, undefined, undefined, { cwd } as never);

    expect(readFileSync(join(cwd, "seek.txt"), "utf8")).toBe("one\ntwo\nthree\ninserted\n");
    const rendered = stripVTControlCharacters(
      tool.renderCall!(
        { input },
        { fg: (_role: string, text: string) => text, bold: (text: string) => text } as never,
        {
          toolCallId: "seek-render",
          cwd,
          argsComplete: true,
          expanded: true,
          state: {},
        } as never,
      )
        .render(200)
        .join("\n"),
    );

    expect(rendered).toContain("4 +inserted");
    expect(rendered).not.toContain("1 +inserted");
  });

  test("renders multi-file headers as dim arrows with colored counts", async () => {
    const cwd = tempDir();
    writeFileSync(join(cwd, "one.txt"), "before one\n");
    writeFileSync(join(cwd, "two.txt"), "before two\n");
    const input = patch(
      "*** Update File: one.txt",
      "@@",
      "-before one",
      "+after one",
      "*** Update File: two.txt",
      "@@",
      "-before two",
      "+after two",
    );
    const tool = createApplyPatchTool();
    await tool.execute("multi-render", { input }, undefined, undefined, { cwd } as never);
    const rendered = stripVTControlCharacters(
      tool.renderCall!(
        { input },
        {
          fg: (role: string, text: string) => `<${role}>${text}</${role}>`,
          bold: (text: string) => text,
        } as never,
        {
          toolCallId: "multi-render",
          cwd,
          argsComplete: true,
          expanded: true,
          state: {},
        } as never,
      )
        .render(200)
        .join("\n"),
    );

    const counts =
      "<toolDiffAdded>+1</toolDiffAdded><dim> </dim>" +
      "<toolDiffRemoved>-1</toolDiffRemoved><dim>)</dim>";
    expect(rendered).toContain(`<dim>→ one.txt</dim><dim> (</dim>${counts}`);
    expect(rendered).toContain(`<dim>→ two.txt</dim><dim> (</dim>${counts}`);
    expect(rendered).not.toContain("└");
  });

  test("uses seek headers to locate changed lines", async () => {
    const cwd = tempDir();
    writeFileSync(join(cwd, "seek.txt"), "old\nanchor\nold\n");
    const input = patch("*** Update File: seek.txt", "@@ anchor", "-old", "+new");
    const tool = createApplyPatchTool();
    await tool.execute("seek-change-render", { input }, undefined, undefined, { cwd } as never);

    expect(readFileSync(join(cwd, "seek.txt"), "utf8")).toBe("old\nanchor\nnew\n");
    const rendered = stripVTControlCharacters(
      tool.renderCall!(
        { input },
        { fg: (_role: string, text: string) => text, bold: (text: string) => text } as never,
        {
          toolCallId: "seek-change-render",
          cwd,
          argsComplete: true,
          expanded: true,
          state: {},
        } as never,
      )
        .render(200)
        .join("\n"),
    );

    expect(rendered).toContain("3 -old");
    expect(rendered).toContain("3 +new");
    expect(rendered).not.toContain("1 -old");
  });

  test("marks partial failures in the retained patch preview", async () => {
    const cwd = tempDir();
    const input = patch(
      "*** Add File: created.txt",
      "+created",
      "*** Update File: missing.txt",
      "@@",
      "-x",
      "+y",
    );
    const tool = createApplyPatchTool();
    const partialResult = await tool.execute("partial-render", { input }, undefined, undefined, {
      cwd,
    } as never);
    const rendered = stripVTControlCharacters(
      tool.renderCall!(
        { input },
        {
          fg: (role: string, text: string) => `<${role}>${text}</${role}>`,
          bold: (text: string) => text,
        } as never,
        {
          toolCallId: "partial-render",
          cwd,
          argsComplete: true,
          expanded: false,
          state: {},
        } as never,
      )
        .render(200)
        .join("\n"),
    );

    expect(rendered).toContain("<warning>Edit partially failed");
    expect(rendered).toContain(
      "<dim>→ missing.txt</dim><error> failed</error><dim> (</dim>" +
        "<toolDiffAdded>+1</toolDiffAdded><dim> </dim>" +
        "<toolDiffRemoved>-1</toolDiffRemoved><dim>)</dim>",
    );

    clearApplyPatchRenderState();
    const restoredContext = {
      toolCallId: "partial-render",
      cwd,
      argsComplete: true,
      expanded: false,
      state: {},
      invalidate: vi.fn(),
    };
    tool.renderResult!(
      partialResult,
      { expanded: false, isPartial: false },
      { fg: (_role: string, text: string) => text, bold: (text: string) => text } as never,
      restoredContext as never,
    );
    const restored = tool.renderCall!(
      { input },
      { fg: (_role: string, text: string) => text, bold: (text: string) => text } as never,
      restoredContext as never,
    )
      .render(200)
      .join("\n");
    expect(restored).toContain("Edit partially failed");
    expect(restored).toContain("missing.txt failed (+1 -1)");

    const failedInput = patch("*** Update File: absent.txt", "@@", "-old", "+new");
    await expect(
      tool.execute("failed-render", { input: failedInput }, undefined, undefined, { cwd } as never),
    ).rejects.toThrow(/apply_patch failed/i);
    const failed = stripVTControlCharacters(
      tool.renderCall!(
        { input: failedInput },
        {
          fg: (role: string, text: string) => `<${role}>${text}</${role}>`,
          bold: (text: string) => text,
        } as never,
        {
          toolCallId: "failed-render",
          cwd,
          argsComplete: true,
          expanded: false,
          state: {},
        } as never,
      )
        .render(200)
        .join("\n"),
    );
    expect(failed).toContain("<error>Edit failed absent.txt (+1 -1)</error>");

    clearApplyPatchRenderState();
    const restoredFailure = stripVTControlCharacters(
      tool.renderCall!(
        { input: failedInput },
        {
          fg: (role: string, text: string) => `<${role}>${text}</${role}>`,
          bold: (text: string) => text,
        } as never,
        {
          toolCallId: "failed-render",
          cwd,
          argsComplete: true,
          expanded: false,
          isError: true,
          state: {},
        } as never,
      )
        .render(200)
        .join("\n"),
    );
    expect(restoredFailure).toContain("<error>Edit failed absent.txt (+1 -1)</error>");
  });

  test("returns render snapshots when lifecycle cleanup races execution", async () => {
    const cwd = tempDir();
    const tool = createApplyPatchTool();

    const successful = tool.execute(
      "cleared-success",
      { input: patch("*** Add File: success.txt", "+success") },
      undefined,
      undefined,
      { cwd } as never,
    );
    clearApplyPatchRenderState();
    await expect(successful).resolves.toMatchObject({
      details: { status: "success", render: { status: "pending" } },
    });

    const partial = tool.execute(
      "cleared-partial",
      {
        input: patch(
          "*** Add File: created.txt",
          "+created",
          "*** Update File: missing.txt",
          "@@",
          "-missing",
          "+changed",
        ),
      },
      undefined,
      undefined,
      { cwd } as never,
    );
    clearApplyPatchRenderState();
    await expect(partial).resolves.toMatchObject({
      details: {
        status: "partial_failure",
        render: { status: "partial_failure", failedTargets: ["missing.txt"] },
      },
    });
  });

  test("deduplicates symlink aliases before acquiring mutation queues", async () => {
    const cwd = tempDir();
    writeFileSync(join(cwd, "real.txt"), "one\ntwo\n");
    symlinkSync("real.txt", join(cwd, "alias.txt"));

    const applied = execute(
      cwd,
      patch(
        "*** Update File: real.txt",
        "@@",
        "-one",
        "+ONE",
        "*** Update File: alias.txt",
        "@@",
        "-two",
        "+TWO",
      ),
    );
    const timeout = delay(500).then(() => {
      throw new Error("apply_patch mutation queue deadlocked on symlink aliases");
    });

    await expect(Promise.race([applied, timeout])).resolves.toMatchObject({
      details: { status: "success" },
    });
    expect(readFileSync(join(cwd, "real.txt"), "utf8")).toBe("ONE\nTWO\n");
  });

  test("queues valid patches that update the same path more than once", async () => {
    const cwd = tempDir();
    const target = join(cwd, "repeated.txt");
    writeFileSync(target, "one\ntwo\n");
    let applied: ReturnType<typeof execute> | undefined;

    await withFileMutationQueue(target, async () => {
      applied = execute(
        cwd,
        patch(
          "*** Update File: repeated.txt",
          "@@",
          "-one",
          "+ONE",
          "*** Update File: repeated.txt",
          "@@",
          "-two",
          "+TWO",
        ),
      );
      await delay(100);
      expect(readFileSync(target, "utf8")).toBe("one\ntwo\n");
    });

    await expect(applied).resolves.toMatchObject({ details: { status: "success" } });
    expect(readFileSync(target, "utf8")).toBe("ONE\nTWO\n");
  });

  test("reports malformed patches, partial success, cancellation, and missing binaries", async () => {
    const cwd = tempDir();
    await expect(execute(cwd, "not a patch")).rejects.toThrow(/invalid patch/i);
    await expect(execute(cwd, patch("*** Add File: ", "+bad"))).rejects.toThrow(/path|patch|file/i);

    const partial = await execute(
      cwd,
      patch(
        "*** Add File: created.txt",
        "+created",
        "*** Update File: missing.txt",
        "@@",
        "-x",
        "+y",
      ),
    );
    expect(partial.details).toMatchObject({
      status: "partial_failure",
      result: { createdFiles: ["created.txt"] },
      failedTargets: ["missing.txt"],
    });
    expect(partial.content[0]).toMatchObject({
      text: expect.stringMatching(/partially failed[\s\S]*MUST read missing\.txt/i),
    });

    const overlapping = await execute(
      cwd,
      patch("*** Add File: name", "+created", "*** Update File: name-long", "@@", "-x", "+y"),
    );
    expect(overlapping.details).toMatchObject({
      status: "partial_failure",
      result: { createdFiles: ["name"] },
      failedTargets: ["name-long"],
    });

    const controller = new AbortController();
    controller.abort();
    await expect(
      execute(cwd, patch("*** Add File: no.txt", "+no"), controller.signal),
    ).rejects.toThrow(/aborted/i);

    const missing = createApplyPatchTool({ binaryPath: join(cwd, "missing-apply-patch") });
    await expect(
      missing.execute(
        "missing",
        { input: patch("*** Add File: no.txt", "+no") },
        undefined,
        undefined,
        {
          cwd,
        } as never,
      ),
    ).rejects.toThrow(/missing-apply-patch|ENOENT/);

    const slowBinary = join(cwd, "slow-apply-patch");
    const ready = join(cwd, "ready");
    const lateMutation = join(cwd, "late-mutation");
    writeFileSync(
      slowBinary,
      [
        "#!/usr/bin/env node",
        'const fs = require("node:fs");',
        `fs.writeFileSync(${JSON.stringify(ready)}, "ready");`,
        `process.on("SIGTERM", () => setTimeout(() => fs.writeFileSync(${JSON.stringify(lateMutation)}, "late"), 50));`,
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );
    chmodSync(slowBinary, 0o755);
    const inFlight = new AbortController();
    const running = createApplyPatchTool({ binaryPath: slowBinary }).execute(
      "abort",
      { input: patch("*** Add File: no.txt", "+no") },
      inFlight.signal,
      undefined,
      { cwd } as never,
    );
    for (let attempt = 0; attempt < 100 && !existsSync(ready); attempt += 1) await delay(5);
    expect(existsSync(ready)).toBe(true);
    inFlight.abort();
    await expect(running).rejects.toThrow(
      /aborted[\s\S]*may have partially applied[\s\S]*no\.txt/i,
    );
    expect(readFileSync(lateMutation, "utf8")).toBe("late");

    const failingBinary = join(cwd, "failing-apply-patch");
    writeFileSync(
      failingBinary,
      '#!/usr/bin/env node\nprocess.stderr.write("native boom\\n");\nprocess.exit(7);\n',
    );
    chmodSync(failingBinary, 0o755);
    await expect(
      createApplyPatchTool({ binaryPath: failingBinary }).execute(
        "failure",
        { input: patch("*** Add File: no.txt", "+no") },
        undefined,
        undefined,
        { cwd } as never,
      ),
    ).rejects.toThrow(/status 7[\s\S]*native boom/i);
    await expect(
      executePatchWithRust({
        cwd,
        patchText: "x".repeat(16 * 1024 * 1024),
        binaryPath: failingBinary,
      }),
    ).rejects.toThrow(/status 7[\s\S]*native boom/i);
  });

  test("bundles only the executable Linux x64 helper", () => {
    const binary = getBundledApplyPatchBinaryPath("linux", "x64");
    expect(binary).toBeDefined();
    expect(statSync(binary!).mode & 0o111).not.toBe(0);
    expect(getBundledApplyPatchBinaryPath("linux", "arm64")).toBeUndefined();
    expect(getBundledApplyPatchBinaryPath("darwin", "x64")).toBeUndefined();
  });

  test("snapshots cwd and marks partial results as errors without retaining ctx", async () => {
    const cwd = tempDir();
    let stale = false;
    const ctx = {
      get cwd() {
        if (stale) throw new Error("stale ctx cwd");
        return cwd;
      },
    };
    const promise = createApplyPatchTool().execute(
      "stale",
      { input: patch("*** Add File: safe.txt", "+safe") },
      undefined,
      undefined,
      ctx as never,
    );
    stale = true;
    await expect(promise).resolves.toMatchObject({ details: { status: "success" } });

    const handlers = new Map<string, (event: any) => unknown>();
    registerApplyPatchTool({
      registerTool: vi.fn(),
      on: vi.fn((name: string, handler: (event: any) => unknown) => handlers.set(name, handler)),
    } as never);
    expect(
      handlers.get("tool_result")?.({
        toolName: "apply_patch",
        details: {
          status: "partial_failure",
          result: { changedFiles: [], createdFiles: [], deletedFiles: [], movedFiles: [], fuzz: 0 },
        },
      }),
    ).toEqual({ isError: true });
  });
});
