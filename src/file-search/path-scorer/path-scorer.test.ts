import { describe, expect, test } from "bun:test";
import { scorePath } from "./index.js";

describe("scorePath", () => {
  test("returns null when query is not an ordered subsequence", () => {
    expect(scorePath("fz", "src/zf.ts")).toBeNull();
  });

  test("returns matched positions for the best alignment", () => {
    expect(scorePath("file", "src/file.ts")?.positions).toEqual([4, 5, 6, 7]);
  });

  test("contiguous matches outrank scattered matches", () => {
    expect(scorePath("file", "src/file.ts")?.score).toBeGreaterThan(
      scorePath("file", "src/f-i-l-e.ts")?.score ?? 0,
    );
  });

  test("filename-local matches outrank directory-only matches", () => {
    expect(scorePath("file", "src/file.ts")?.score).toBeGreaterThan(
      scorePath("file", "file/src/search.ts")?.score ?? 0,
    );
  });

  test("boundary matches outrank mid-token matches", () => {
    expect(scorePath("search", "src/file-search.ts")?.score).toBeGreaterThan(
      scorePath("search", "src/filesearch.ts")?.score ?? 0,
    );
  });

  test("camel and number transitions receive bonuses", () => {
    expect(scorePath("fb", "src/fooBar.ts")?.score).toBeGreaterThan(
      scorePath("fb", "src/foobaz.ts")?.score ?? 0,
    );
    expect(scorePath("f1", "src/foo1.ts")?.score).toBeGreaterThan(
      scorePath("f1", "src/foo01.ts")?.score ?? 0,
    );
  });

  test("lowercase query is case-insensitive", () => {
    expect(scorePath("foo", "src/FooBar.ts")).not.toBeNull();
  });

  test("uppercase query is case-sensitive", () => {
    expect(scorePath("Foo", "src/fooBar.ts")).toBeNull();
    expect(scorePath("Foo", "src/FooBar.ts")).not.toBeNull();
  });
});
