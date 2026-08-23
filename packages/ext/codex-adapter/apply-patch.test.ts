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
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test, vi } from "vitest";

import { getBundledApplyPatchBinaryPath } from "./apply-patch/binary.js";
import { executePatchWithRust } from "./apply-patch/executor.js";
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
