import { describe, expect, test } from "vitest";
import { searchPaths } from "./index.js";

describe("searchPaths", () => {
  test("empty query returns deterministic capped results", () => {
    expect(searchPaths("", ["b.ts", "a.ts", "c.ts"], { limit: 2 })).toEqual([
      { path: "b.ts", score: expect.any(Number) },
      { path: "a.ts", score: expect.any(Number) },
    ]);
  });

  test("empty query can be ranked by boost", () => {
    expect(
      searchPaths("", ["b.ts", "a.ts", "c.ts"], {
        limit: 2,
        boost: (path) => (path === "c.ts" ? 10 : 0),
      }).map((result) => result.path),
    ).toEqual(["c.ts", "b.ts"]);
  });

  test("default limit is 20", () => {
    const items = Array.from({ length: 25 }, (_, index) => `file-${index}.ts`);

    expect(searchPaths("", items)).toHaveLength(20);
  });

  test("query characters must appear in order", () => {
    expect(
      searchPaths("fz", ["src/fzf-file-search.ts", "src/zf.ts"]).map((item) => item.path),
    ).toEqual(["src/fzf-file-search.ts"]);
  });

  test("non-matching paths are excluded", () => {
    expect(searchPaths("xyz", ["src/file-search/path.ts", "src/profile.ts"])).toEqual([]);
  });

  test("contiguous match outranks scattered match", () => {
    const results = searchPaths("file", ["src/f-i-l-e.ts", "src/file.ts"]);

    expect(results.map((result) => result.path)).toEqual(["src/file.ts", "src/f-i-l-e.ts"]);
  });

  test("matching query can be ranked by boost", () => {
    expect(
      searchPaths("file", ["src/file.ts", "src/other-file.ts"], {
        boost: (path) => (path === "src/other-file.ts" ? 1000 : 0),
      }).map((result) => result.path),
    ).toEqual(["src/other-file.ts", "src/file.ts"]);
  });

  test("filename match outranks directory-only match", () => {
    const results = searchPaths("file", ["file-search/path.ts", "src/file.ts"]);

    expect(results.map((result) => result.path)).toEqual(["src/file.ts", "file-search/path.ts"]);
  });

  test("path boundary match outranks mid-token match", () => {
    const results = searchPaths("search", ["src/filesearch.ts", "src/file-search.ts"]);

    expect(results.map((result) => result.path)).toEqual([
      "src/file-search.ts",
      "src/filesearch.ts",
    ]);
  });

  test("lowercase query matches case-insensitively", () => {
    expect(searchPaths("foo", ["src/FooBar.ts"])).toEqual([
      { path: "src/FooBar.ts", score: expect.any(Number) },
    ]);
  });

  test("uppercase query becomes case-sensitive", () => {
    expect(
      searchPaths("Foo", ["src/FooBar.ts", "src/fooBar.ts"]).map((result) => result.path),
    ).toEqual(["src/FooBar.ts"]);
  });

  test("results are sorted descending by score", () => {
    const results = searchPaths("fs", ["src/f-s.ts", "src/file-search.ts", "src/fs.ts"]);

    expect(results.map((result) => result.score)).toEqual(
      [...results].map((result) => result.score).sort((a, b) => b - a),
    );
  });

  test("result count respects limit", () => {
    expect(searchPaths("ts", ["a.ts", "b.ts", "c.ts"], { limit: 2 })).toHaveLength(2);
  });

  test("accepts pre-normalized items", () => {
    expect(searchPaths("path", [{ path: "src/Path.ts", lowerPath: "src/path.ts" }])[0]?.path).toBe(
      "src/Path.ts",
    );
  });
});
