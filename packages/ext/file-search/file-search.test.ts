import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CombinedAutocompleteProvider, type AutocompleteProvider } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import registerFileSearch from "./index.js";

const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@ff-labs/fff-node", () => ({ FileFinder: { create } }));

function mockFinder() {
  return {
    isDestroyed: false,
    waitForScan: vi.fn(async () => ({ ok: true, value: true })),
    isScanning: vi.fn(() => false),
    scanFiles: vi.fn(() => ({ ok: true })),
    mixedSearch: vi.fn(() => ({
      ok: true,
      value: {
        items: [
          { type: "file", item: { relativePath: "src/my file.ts", fileName: "my file.ts" } },
          { type: "directory", item: { relativePath: "src/", dirName: "src/" } },
        ],
      },
    })),
    trackQuery: vi.fn((): { ok: true; value: boolean } | { ok: false; error: string } => ({
      ok: true,
      value: true,
    })),
    destroy: vi.fn(function (this: { isDestroyed: boolean }) {
      this.isDestroyed = true;
    }),
  };
}

type Finder = ReturnType<typeof mockFinder>;
let dir: string;
let finders: Finder[];
let shutdown: (() => void) | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-bites-fff-test-"));
  vi.stubEnv("XDG_CACHE_HOME", join(dir, "cache"));
  vi.stubEnv("XDG_DATA_HOME", join(dir, "data"));
  vi.stubEnv("XDG_RUNTIME_DIR", join(dir, "runtime"));
  vi.stubEnv("FFF_FRECENCY_DB", undefined);
  vi.stubEnv("FFF_HISTORY_DB", undefined);
  finders = [];
  create.mockReset();
  create.mockImplementation(() => {
    const finder = mockFinder();
    finders.push(finder);
    return { ok: true, value: finder };
  });
});

afterEach(() => {
  shutdown?.();
  shutdown = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

function setup(flags: Record<string, string> = {}) {
  const handlers = new Map<string, (event: never, ctx: never) => unknown>();
  const commands = new Map<string, { handler: () => Promise<void> }>();
  const pi = {
    on: (name: string, handler: (event: never, ctx: never) => unknown) =>
      handlers.set(name, handler),
    registerFlag: vi.fn(),
    getFlag: (name: string) => flags[name],
    registerCommand: (name: string, command: { handler: () => Promise<void> }) =>
      commands.set(name, command),
  };
  registerFileSearch(pi as never);
  shutdown = () => handlers.get("session_shutdown")?.({} as never, {} as never);
  const fallback = { prefix: "@", items: [{ value: "@built-in", label: "built-in" }] };

  function start(cwd = join(dir, "repo")) {
    const current = {
      getSuggestions: vi.fn(async () => fallback),
      applyCompletion: vi.fn<AutocompleteProvider["applyCompletion"]>(
        (lines, cursorLine, cursorCol) => ({
          lines,
          cursorLine,
          cursorCol,
        }),
      ),
      shouldTriggerFileCompletion: vi.fn(() => false),
    };
    const notify = vi.fn();
    let provider: AutocompleteProvider | undefined;
    const ui = {
      notify,
      addAutocompleteProvider: (
        factory: (current: AutocompleteProvider) => AutocompleteProvider,
      ) => {
        provider = factory(current);
      },
    };
    let stale = false;
    const ctx = {
      get cwd() {
        if (stale) throw new Error("stale ctx.cwd");
        return cwd;
      },
      get ui() {
        if (stale) throw new Error("stale ctx.ui");
        return ui;
      },
    };
    handlers.get("session_start")?.({} as never, ctx as never);
    if (!provider) throw new Error("No autocomplete provider installed");
    const installed = provider;
    return {
      current,
      notify,
      provider: installed,
      cwd,
      stale: () => {
        stale = true;
      },
      suggestions: (text = "@file", signal = new AbortController().signal) =>
        installed.getSuggestions([text], 0, text.length, { signal, force: false }),
    };
  }
  return { start, commands, fallback };
}

function nvimDatabases() {
  const frecency = join(dir, "cache", "nvim", "fff_nvim");
  const history = join(dir, "data", "nvim", "fff_queries");
  mkdirSync(frecency, { recursive: true });
  mkdirSync(history, { recursive: true });
  return { frecencyDbPath: frecency, historyDbPath: history };
}

test("prewarms FFF using existing Neovim databases, without content caches or watching", async () => {
  const databases = nvimDatabases();
  const session = setup().start();
  await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
  expect(create).toHaveBeenCalledWith({
    basePath: session.cwd,
    aiMode: false,
    ...databases,
    disableMmapCache: true,
    disableContentIndexing: true,
    disableWatch: true,
  });
  await session.suggestions();
});

test("CLI overrides environment overrides Neovim, independently for each database", async () => {
  nvimDatabases();
  vi.stubEnv("FFF_FRECENCY_DB", "/env/frecency");
  vi.stubEnv("FFF_HISTORY_DB", "/env/history");
  const session = setup({ "fff-frecency-db": "/flag/frecency" }).start();
  await session.suggestions();
  expect(create.mock.calls[0]?.[0]).toMatchObject({
    frecencyDbPath: "/flag/frecency",
    historyDbPath: "/env/history",
  });
});

test("uses a private temporary fallback only for missing Neovim directories", async () => {
  const databases = nvimDatabases();
  rmSync(databases.historyDbPath, { recursive: true });
  writeFileSync(databases.historyDbPath, "not an LMDB directory");
  const session = setup().start();
  await session.suggestions();
  const paths = create.mock.calls[0]?.[0];
  expect(paths.frecencyDbPath).toBe(databases.frecencyDbPath);
  expect(paths.historyDbPath).toMatch(new RegExp(`^${dir}/runtime/pi-bites-fff-`));
  expect(paths.historyDbPath).toMatch(/-history$/);
  expect(statSync(join(paths.historyDbPath, "..")).mode & 0o777).toBe(0o700);
});

test.each([
  "@~/",
  "@~/file",
  "@/",
  "@/etc/file",
  "@./file",
  "@../file",
  "@src/",
  '@"my dir/"',
  "/command",
])("delegates %s without searching the workspace index", async (text) => {
  const { start, fallback } = setup();
  const session = start();
  expect(await session.suggestions(text)).toEqual(fallback);
  expect(session.current.getSuggestions).toHaveBeenCalledWith(
    [text],
    0,
    text.length,
    expect.any(Object),
  );
  expect(finders.every((f) => f.mixedSearch.mock.calls.length === 0)).toBe(true);
});

test.each([
  ["@src/file", "src/file"],
  ['@"my file"', "my file"],
  ['@"my file', "my file"],
  ["open (@file", "file"],
  ["open `@file", "file"],
  ["open\u3000@file", "file"],
])(
  "extracts query from %s and preserves FFF ranking and insertion behavior",
  async (text, query) => {
    const session = setup().start();
    const result = await session.suggestions(text);
    expect(finders[0]?.mixedSearch).toHaveBeenCalledWith(query, { pageSize: 20 });
    expect(result?.items).toEqual([
      { value: '@"src/my file.ts"', label: "my file.ts", description: "src/my file.ts" },
      {
        value: result?.prefix.startsWith('@"') ? '@"src/"' : "@src/",
        label: "src/",
        description: "src/",
      },
    ]);
    const item = result!.items[0]!;
    const lines = [text];
    expect(session.provider.applyCompletion(lines, 0, text.length, item, result!.prefix)).toEqual({
      lines,
      cursorLine: 0,
      cursorCol: text.length,
    });
    expect(session.current.applyCompletion).toHaveBeenCalledWith(
      lines,
      0,
      text.length,
      item,
      result!.prefix,
    );
    expect(finders[0]?.trackQuery).toHaveBeenCalledWith(query, join(session.cwd, "src/my file.ts"));
    expect(session.provider.shouldTriggerFileCompletion?.(lines, 0, text.length)).toBe(false);
  },
);

test("does not track directory or built-in selections", async () => {
  const { start, fallback } = setup();
  const session = start();
  const result = await session.suggestions();
  session.provider.applyCompletion(["@file"], 0, 5, result!.items[1]!, result!.prefix);
  session.provider.applyCompletion(["@file"], 0, 5, fallback.items[0]!, fallback.prefix);
  expect(finders[0]?.trackQuery).not.toHaveBeenCalled();
});

test("delegates empty results to Pi", async () => {
  const { start, fallback } = setup();
  const session = start();
  await session.suggestions();
  finders[0]!.mixedSearch.mockReturnValue({ ok: true, value: { items: [] } });
  expect(await session.suggestions("@missing")).toEqual(fallback);
  expect(session.notify).not.toHaveBeenCalled();
});

test("retries database-free FFF and warns once when database opening fails", async () => {
  create.mockReturnValueOnce({ ok: false, error: "database lock failed" });
  const session = setup().start();
  expect((await session.suggestions())?.items[0]?.label).toBe("my file.ts");
  expect(create).toHaveBeenCalledTimes(2);
  expect(create.mock.calls[1]?.[0]).not.toHaveProperty("frecencyDbPath");
  expect(create.mock.calls[1]?.[0]).not.toHaveProperty("historyDbPath");
  await session.suggestions();
  expect(session.notify).toHaveBeenCalledExactlyOnceWith(
    expect.stringContaining("database lock failed"),
    "warning",
  );
});

test("falls back visibly without repeated init attempts, and manual rescan can retry", async () => {
  create.mockReturnValueOnce({ ok: false, error: "database failure" });
  create.mockReturnValueOnce({ ok: false, error: "native failure" });
  const { start, fallback, commands } = setup();
  const session = start();
  expect(await session.suggestions()).toEqual(fallback);
  expect(await session.suggestions()).toEqual(fallback);
  expect(create).toHaveBeenCalledTimes(2);
  expect(session.notify).toHaveBeenCalledTimes(1);
  expect(session.notify).toHaveBeenCalledWith(
    expect.stringContaining("Using Pi completion"),
    "warning",
  );
  await commands.get("fff-rescan")?.handler();
  expect(create).toHaveBeenCalledTimes(3);
  expect(finders[0]?.scanFiles).toHaveBeenCalledOnce();
});

test("search failures fall back visibly and do not break completion insertion", async () => {
  const { start, fallback } = setup();
  const session = start();
  const result = await session.suggestions();
  finders[0]!.trackQuery.mockReturnValue({ ok: false, error: "history write failed" });
  expect(() =>
    session.provider.applyCompletion(["@file"], 0, 5, result!.items[0]!, "@file"),
  ).not.toThrow();
  finders[0]!.mixedSearch.mockImplementation(() => {
    throw new Error("native search failed");
  });
  expect(await session.suggestions()).toEqual(fallback);
  expect(await session.suggestions()).toEqual(fallback);
  expect(
    session.notify.mock.calls.filter(([message]) => message.includes("native search failed")),
  ).toHaveLength(1);
});

test("serializes startup, cancels stale requests, and never reads an expired ctx", async () => {
  let finishScan!: (result: { ok: boolean; value: boolean }) => void;
  const finder = mockFinder();
  finder.waitForScan.mockImplementation(
    () =>
      new Promise((done) => {
        finishScan = done;
      }),
  );
  create.mockReturnValue({ ok: true, value: finder });
  const session = setup().start();
  const controller = new AbortController();
  const cancelled = session.suggestions("@one", controller.signal);
  const latest = session.suggestions("@two");
  session.stale();
  await vi.waitFor(() => expect(finder.waitForScan).toHaveBeenCalledOnce());
  expect(finder.mixedSearch).not.toHaveBeenCalled();
  controller.abort();
  finishScan({ ok: true, value: true });
  expect(await cancelled).toBeNull();
  expect((await latest)?.items[0]?.label).toBe("my file.ts");
  expect(create).toHaveBeenCalledOnce();
  expect(finder.mixedSearch).toHaveBeenCalledExactlyOnceWith("two", { pageSize: 20 });
});

test("uses Pi while the initial scan is incomplete, then enables FFF", async () => {
  const finder = mockFinder();
  finder.waitForScan.mockResolvedValue({ ok: true, value: false });
  finder.isScanning.mockReturnValue(true);
  create.mockReturnValue({ ok: true, value: finder });
  const { start, fallback } = setup();
  const session = start();
  session.stale();
  expect(await session.suggestions()).toEqual(fallback);
  expect(finder.mixedSearch).not.toHaveBeenCalled();
  expect(session.notify).toHaveBeenCalledWith(expect.stringContaining("still indexing"), "warning");
  finder.isScanning.mockReturnValue(false);
  expect((await session.suggestions())?.items[0]?.label).toBe("my file.ts");
});

test("refreshes on demand at most every 30 seconds, skips active scans, and exposes manual rescan", async () => {
  let now = 100_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const { start, commands } = setup();
  const session = start();
  await session.suggestions();
  const finder = finders[0]!;
  now += 29_999;
  await session.suggestions();
  expect(finder.scanFiles).not.toHaveBeenCalled();
  now += 1;
  await session.suggestions();
  await session.suggestions();
  expect(finder.scanFiles).toHaveBeenCalledOnce();
  now += 30_000;
  finder.isScanning.mockReturnValue(true);
  await session.suggestions();
  expect(finder.scanFiles).toHaveBeenCalledOnce();
  finder.isScanning.mockReturnValue(false);
  await session.suggestions();
  expect(finder.scanFiles).toHaveBeenCalledTimes(2);
  session.stale();
  await commands.get("fff-rescan")?.handler();
  expect(finder.scanFiles).toHaveBeenCalledTimes(3);
});

test("replacement destroys pending old finders without touching stale ctx or the new session", async () => {
  let finishScan!: (result: { ok: boolean; value: boolean }) => void;
  const old = mockFinder();
  old.waitForScan.mockImplementation(
    () =>
      new Promise((done) => {
        finishScan = done;
      }),
  );
  create.mockReturnValueOnce({ ok: true, value: old });
  const { start } = setup();
  const first = start();
  const lookup = first.suggestions();
  await vi.waitFor(() => expect(old.waitForScan).toHaveBeenCalledOnce());
  first.stale();
  const second = start(join(dir, "other-repo"));
  expect(old.destroy).toHaveBeenCalledOnce();
  finishScan({ ok: true, value: true });
  expect(await lookup).toBeNull();
  expect((await second.suggestions())?.items[0]?.label).toBe("my file.ts");
  expect(first.notify).not.toHaveBeenCalled();
  expect(finders[0]?.destroy).not.toHaveBeenCalled();
  shutdown?.();
  second.stale();
  expect(await second.suggestions()).toBeNull();
  expect(finders[0]?.destroy).toHaveBeenCalledOnce();
});

test.each([
  ['@"conf"', 6, "config.ts", '@"config.ts" '],
  ['@"conf" tail', 7, "config.ts", '@"config.ts"  tail'],
  ["@conf", 5, "my\tconfig.ts", '@"my\tconfig.ts" '],
  ["@conf", 5, "my\u3000config.ts", '@"my\u3000config.ts" '],
  ["@conf", 5, "my，config.ts", '@"my，config.ts" '],
  ["@conf", 5, "my。config.ts", '@"my。config.ts" '],
])(
  "inserts %s safely using Pi's real completion implementation",
  async (text, cursor, path, expected) => {
    const session = setup().start();
    await session.suggestions();
    finders[0]!.mixedSearch.mockReturnValue({
      ok: true,
      value: { items: [{ type: "file", item: { relativePath: path, fileName: path } }] },
    });
    const result = await session.provider.getSuggestions([text], 0, cursor, {
      signal: new AbortController().signal,
      force: false,
    });
    const native = new CombinedAutocompleteProvider([], session.cwd);
    session.current.applyCompletion.mockImplementation(native.applyCompletion.bind(native));
    const completion = session.provider.applyCompletion(
      [text],
      0,
      cursor,
      result!.items[0]!,
      result!.prefix,
    );
    expect(completion.lines).toEqual([expected]);
    expect(completion.cursorCol).toBe(
      expected.endsWith(" tail") ? expected.length - 5 : expected.length,
    );
  },
);

test("preserves quoted directory insertion and cursor placement using Pi", async () => {
  const session = setup().start();
  const text = '@"sr"';
  const result = await session.provider.getSuggestions([text], 0, 4, {
    signal: new AbortController().signal,
    force: false,
  });
  const native = new CombinedAutocompleteProvider([], session.cwd);
  session.current.applyCompletion.mockImplementation(native.applyCompletion.bind(native));
  const completion = session.provider.applyCompletion(
    [text],
    0,
    4,
    result!.items[1]!,
    result!.prefix,
  );
  expect(completion.lines).toEqual(['@"src/"']);
  expect(completion.cursorCol).toBe(6);
});

test("database path preparation failures still use database-free FFF", async () => {
  const notDirectory = join(dir, "runtime-file");
  writeFileSync(notDirectory, "not a directory");
  vi.stubEnv("XDG_RUNTIME_DIR", notDirectory);
  const session = setup().start();
  expect((await session.suggestions())?.items[0]?.label).toBe("my file.ts");
  expect(create).toHaveBeenCalledOnce();
  expect(create.mock.calls[0]?.[0]).not.toHaveProperty("frecencyDbPath");
  expect(create.mock.calls[0]?.[0]).not.toHaveProperty("historyDbPath");
  expect(session.notify).toHaveBeenCalledExactlyOnceWith(
    expect.stringContaining("Using FFF without ranking history"),
    "warning",
  );
});

test.each(["symlink", "public", "different owner"])(
  "rejects a %s fallback directory without disabling FFF",
  async (unsafe) => {
    const { start } = setup();
    await start().suggestions();
    const parent = dirname(create.mock.calls[0]?.[0].frecencyDbPath);
    const target = join(dir, "symlink-target");
    if (unsafe === "symlink") {
      rmSync(parent, { recursive: true });
      mkdirSync(target);
      symlinkSync(target, parent);
    } else if (unsafe === "public") {
      chmodSync(parent, 0o777);
    } else {
      vi.spyOn(process, "geteuid").mockReturnValue(process.geteuid!() + 1);
    }
    create.mockClear();
    const session = start();
    expect((await session.suggestions())?.items[0]?.label).toBe("my file.ts");
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty("frecencyDbPath");
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty("historyDbPath");
    expect(session.notify).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("FFF state directory is not private"),
      "warning",
    );
    if (unsafe === "symlink") expect(readdirSync(target)).toEqual([]);
  },
);
