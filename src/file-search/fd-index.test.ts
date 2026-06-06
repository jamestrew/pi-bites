import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { listProjectPaths } from "./fd-index.js";

const fdAvailable = Bun.which("fd") !== null;
const describeIfFd = fdAvailable ? describe : describe.skip;

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await Bun.$`mktemp -d`.text().then((path) => path.trim());
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describeIfFd("listProjectPaths", () => {
  test("lists cwd-relative files and directories", async () => {
    await mkdir(join(tmpDir, "src", "nested"), { recursive: true });
    await mkdir(join(tmpDir, ".hidden-dir"), { recursive: true });
    await mkdir(join(tmpDir, ".git"), { recursive: true });
    await writeFile(join(tmpDir, "src", "index.ts"), "");
    await writeFile(join(tmpDir, ".hidden-dir", "secret.txt"), "");
    await writeFile(join(tmpDir, ".git", "config"), "");

    const paths = await listProjectPaths(tmpDir);

    expect(paths).toContain("src");
    expect(paths).toContain("src/nested");
    expect(paths).toContain("src/index.ts");
    expect(paths).toContain(".hidden-dir");
    expect(paths).toContain(".hidden-dir/secret.txt");
    expect(paths).not.toContain(".git");
    expect(paths).not.toContain(".git/config");
    expect(paths).toEqual([...paths].sort());
  });

  test("respects gitignore through fd defaults", async () => {
    await mkdir(join(tmpDir, ".git"), { recursive: true });
    await writeFile(join(tmpDir, ".gitignore"), "ignored.txt\n");
    await writeFile(join(tmpDir, "ignored.txt"), "");
    await writeFile(join(tmpDir, "visible.txt"), "");

    const paths = await listProjectPaths(tmpDir);

    expect(paths).toContain("visible.txt");
    expect(paths).not.toContain("ignored.txt");
  });

  test("rejects when aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(listProjectPaths(tmpDir, controller.signal)).rejects.toThrow("Operation aborted");
  });
});
