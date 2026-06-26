import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { FileFrecency } from "./index.js";

describe("FileFrecency", () => {
  test("visits increase score and persist cwd-local paths", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-bites-frecency-"));
    const file = join(dir, "frecency.json");

    try {
      const frecency = new FileFrecency(file);
      await frecency.load("/repo");

      frecency.visit("file-a");
      const oneVisit = frecency.score("file-a");
      frecency.visit("file-a");

      expect(frecency.score("file-a")).toBeGreaterThan(oneVisit);

      await frecency.save();

      const reloaded = new FileFrecency(file);
      await reloaded.load("/repo");

      expect(reloaded.score("file-a")).toBeGreaterThan(0);
      expect(reloaded.score("/repo\0file-a")).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("prunes paths missing from the refreshed index", async () => {
    const frecency = new FileFrecency("unused.json");
    await frecency.load("/repo");

    frecency.visit("kept.ts");
    frecency.visit("deleted.ts");

    expect(frecency.pruneMissing(["kept.ts"])).toBe(1);
    expect(frecency.score("kept.ts")).toBeGreaterThan(0);
    expect(frecency.score("deleted.ts")).toBe(0);
  });

  test("save preserves other cwd buckets", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-bites-frecency-"));
    const file = join(dir, "frecency.json");

    try {
      await writeFile(file, JSON.stringify({ "/other": { "other-file": 123 } }), "utf8");

      const frecency = new FileFrecency(file);
      await frecency.load("/repo");
      frecency.visit("repo-file");
      await frecency.save();

      const stored = JSON.parse(await readFile(file, "utf8"));
      expect(stored["/other"]["other-file"]).toBe(123);
      expect(stored["/repo"]["repo-file"]).toEqual(expect.any(Number));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("loads old flat cwd-prefixed keys into the cwd-local cache", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-bites-frecency-"));
    const file = join(dir, "frecency.json");

    try {
      await writeFile(file, JSON.stringify({ "/repo\0src/index.ts": Date.now() / 1000 }), "utf8");

      const frecency = new FileFrecency(file);
      await frecency.load("/repo");

      expect(frecency.score("src/index.ts")).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
