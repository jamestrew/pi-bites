import { afterEach, describe, expect, mock, test } from "bun:test";

const listProjectPathsMock = mock(async (cwd: string) => [`${cwd}/file.ts`]);

mock.module("./fd-index.js", () => ({
  listProjectPaths: listProjectPathsMock,
}));

const { PathIndex } = await import("./path-index.js");

afterEach(() => {
  listProjectPathsMock.mockClear();
  listProjectPathsMock.mockImplementation(async (cwd: string) => [`${cwd}/file.ts`]);
});

describe("PathIndex", () => {
  test("caches paths by cwd", async () => {
    const index = new PathIndex();

    await expect(index.getPaths("/repo")).resolves.toEqual(["/repo/file.ts"]);
    await expect(index.getPaths("/repo")).resolves.toEqual(["/repo/file.ts"]);

    expect(listProjectPathsMock).toHaveBeenCalledTimes(1);
  });

  test("shares a pending load", async () => {
    let resolvePaths!: (paths: string[]) => void;
    listProjectPathsMock.mockImplementation(
      () => new Promise<string[]>((resolve) => (resolvePaths = resolve)),
    );

    const index = new PathIndex();
    const first = index.getPaths("/repo");
    const second = index.getPaths("/repo");

    resolvePaths(["a.ts"]);

    await expect(first).resolves.toEqual(["a.ts"]);
    await expect(second).resolves.toEqual(["a.ts"]);
    expect(listProjectPathsMock).toHaveBeenCalledTimes(1);
  });

  test("refresh forces a new load", async () => {
    const index = new PathIndex();

    await expect(index.getPaths("/repo")).resolves.toEqual(["/repo/file.ts"]);

    listProjectPathsMock.mockImplementation(async () => ["fresh.ts"]);
    await expect(index.refresh("/repo")).resolves.toEqual(["fresh.ts"]);
    await expect(index.getPaths("/repo")).resolves.toEqual(["fresh.ts"]);

    expect(listProjectPathsMock).toHaveBeenCalledTimes(2);
  });

  test("failed loads are retryable", async () => {
    const index = new PathIndex();
    listProjectPathsMock.mockImplementationOnce(async () => {
      throw new Error("fd failed");
    });

    await expect(index.getPaths("/repo")).rejects.toThrow("fd failed");
    await expect(index.getPaths("/repo")).resolves.toEqual(["/repo/file.ts"]);

    expect(listProjectPathsMock).toHaveBeenCalledTimes(2);
  });

  test("clear drops cached paths", async () => {
    const index = new PathIndex();

    await index.getPaths("/repo");
    index.clear("/repo");
    await index.getPaths("/repo");

    expect(listProjectPathsMock).toHaveBeenCalledTimes(2);
  });
});
