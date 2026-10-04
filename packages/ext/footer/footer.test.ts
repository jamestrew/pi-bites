import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  watch,
  writeFileSync,
  type FSWatcher,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import type { Component } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { expect, test, vi } from "vitest";

import { visibleWidth } from "@earendil-works/pi-tui";

import registerFooter, {
  buildExtensionStatusLines,
  buildFooterLine,
  SubagentUsageReader,
  formatUsageStats,
  readRepositoryStatus,
  watchJjMetadata,
  type RepositoryStatus,
  type UsageTotals,
} from "./index.js";

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, watch: vi.fn(fs.watch) };
});

const footerData = {
  getGitBranch: () => "main",
  getExtensionStatuses: () => new Map<string, string>(),
  onBranchChange: () => () => undefined,
};

function usage(overrides: Partial<UsageTotals> = {}): UsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, ...overrides };
}

test("formatUsageStats renders compact labels and cache hit percentage", () => {
  expect(
    formatUsageStats(usage({ input: 1_000, output: 250, cacheRead: 3_000, cost: 0.1234 })),
  ).toBe("↑1.0k ↓250 R3.0k CH75.0% $0.123");
});

test("buildFooterLine combines main and subagent token usage", () => {
  const ctx: any = {
    cwd: "/repo",
    model: { provider: "openai-codex", id: "gpt-5.5", contextWindow: 272_000 },
    getContextUsage: () => ({ tokens: 27_000, contextWindow: 272_000, percent: 7.7 }),
    sessionManager: {
      getBranch: () => [{ type: "thinking_level_change", thinkingLevel: "low" }],
      getEntries: () => [
        {
          type: "message",
          message: {
            role: "assistant",
            usage: {
              input: 40_000,
              output: 3_000,
              cacheRead: 80_000,
              cacheWrite: 0,
              cost: { total: 0.3 },
            },
          },
        },
      ],
    },
  };

  const line = buildFooterLine(
    ctx,
    footerData,
    usage({ input: 6_000, output: 100, cacheRead: 3_000, cost: 0.068 }),
    140,
  );

  expect(line).toContain("openai-codex/gpt-5.5 low · 27k/272k 7.7%");
  expect(line).toContain("↑46k ↓3.1k R83k CH64.3% $0.368");
  expect(line).toContain("repo (main)");
});

test.each<[string, RepositoryStatus, string]>([
  ["/projects/pi-bites", { root: "/projects/pi-bites" }, "pi-bites (main)"],
  [
    "/projects/pi-bites/packages/ext/footer",
    { root: "/projects/pi-bites", jj: "jj: qu · feature/footer" },
    "pi-bites/packages/ext/footer (jj: qu · feature/footer)",
  ],
  ["/projects/pi-bites", { root: "/projects/pi-bites", jj: "jj: qu" }, "pi-bites (jj: qu)"],
  ["/tmp/scratch", {}, "scratch (main)"],
])("buildFooterLine formats repository location %s", (cwd, repository, expected) => {
  const ctx: any = {
    cwd,
    getContextUsage: () => undefined,
    sessionManager: { getBranch: () => [], getEntries: () => [] },
  };
  expect(buildFooterLine(ctx, footerData, usage(), 140, undefined, repository)).toContain(expected);
});

const processPi: Pick<ExtensionAPI, "exec"> = {
  exec: async (command, args, options) => {
    const result = spawnSync(command, args, {
      cwd: options?.cwd,
      timeout: options?.timeout,
      encoding: "utf8",
    });
    return {
      code: result.status ?? 1,
      stdout: result.stdout,
      stderr: result.stderr,
      killed: false,
    };
  },
};

test("readRepositoryStatus falls back to Git and tolerates unavailable executables", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-footer-git-"));
  try {
    expect(await readRepositoryStatus(processPi, dir)).toEqual({ root: undefined });
    execFileSync("git", ["init", dir], { stdio: "pipe" });
    const nested = join(dir, "src");
    mkdirSync(nested);
    expect(await readRepositoryStatus(processPi, nested)).toEqual({ root: dir });
    expect(
      await readRepositoryStatus(
        {
          exec: async () => {
            throw new Error("missing");
          },
        },
        dir,
      ),
    ).toEqual({ root: undefined });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test.skipIf(spawnSync("jj", ["--version"]).status !== 0)(
  "jj status prefers current bookmarks, then nearest bookmarked ancestors, without mutating HEAD",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-footer-jj-"));
    const jj = (...args: string[]) =>
      execFileSync(
        "jj",
        ["--config", "user.name=Test", "--config", "user.email=test@example.com", ...args],
        {
          cwd: dir,
          stdio: "pipe",
        },
      );
    try {
      jj("git", "init", "--colocate");
      const nested = join(dir, "src");
      mkdirSync(nested);
      const read = () => readRepositoryStatus(processPi, nested);
      expect(await read()).toEqual({ root: dir, jj: expect.stringMatching(/^jj: [a-z]+$/) });
      jj("bookmark", "create", "base");
      jj("new", "-m", "first");
      jj("bookmark", "create", "feature/footer");
      jj("new", "-m", "second");
      const head = readFileSync(join(dir, ".git", "HEAD"), "utf8");
      expect((await read()).jj).toMatch(/^jj: [a-z]+ · feature\/footer$/);
      expect(readFileSync(join(dir, ".git", "HEAD"), "utf8")).toBe(head);
      jj("bookmark", "create", "current");
      expect((await read()).jj).toMatch(/ · current$/);
      jj("bookmark", "delete", "current");
      jj("bookmark", "rename", "feature/footer", "renamed");
      expect((await read()).jj).toMatch(/ · renamed$/);
      jj("new", "base", "-m", "side");
      jj("bookmark", "create", "side");
      jj("new", "renamed", "side", "-m", "merge");
      const merged = (await read()).jj;
      expect(merged).toContain("renamed");
      expect(merged).toContain("side");
      expect(merged).not.toContain("base");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("jj refresh is metadata-driven, debounced, cached, and safe after ctx disposal", async () => {
  vi.useFakeTimers();
  const dir = mkdtempSync(join(tmpdir(), "pi-footer-watch-"));
  const heads = join(dir, ".jj", "repo", "op_heads", "heads");
  const workingCopy = join(dir, ".jj", "working_copy");
  mkdirSync(heads, { recursive: true });
  mkdirSync(workingCopy, { recursive: true });
  writeFileSync(join(heads, "a"), "");
  writeFileSync(join(workingCopy, "checkout"), "initial");
  const callbacks: (() => void)[] = [];
  const close = vi.fn();
  vi.mocked(watch).mockImplementation((_path: any, _options: any, callback?: any) => {
    callbacks.push(callback);
    return { on: () => undefined, close } as unknown as FSWatcher;
  });
  const handlers = new Map<string, (...args: any[]) => any>();
  let component: Component & { dispose(): void };
  let stale = false;
  const requestRender = vi.fn();
  const unsubscribe = vi.fn();
  let bookmark = "main";
  const exec = vi.fn(async (_command: string, args: string[]) => ({
    code: 0,
    stdout: args.includes("root") ? dir : args.includes("@") ? "qu" : bookmark,
    stderr: "",
    killed: false,
  }));
  const ctx = {
    get cwd() {
      if (stale) throw new Error("stale ctx");
      return dir;
    },
    get sessionManager() {
      if (stale) throw new Error("stale ctx");
      return { getSessionId: () => "session" };
    },
    get ui() {
      if (stale) throw new Error("stale ctx");
      return {
        setFooter: (factory: any) => {
          component = factory(
            { requestRender },
            {},
            {
              ...footerData,
              onBranchChange: () => unsubscribe,
            },
          );
        },
      };
    },
  };
  registerFooter({
    on: (event: string, handler: any) => handlers.set(event, handler),
    exec,
  } as unknown as ExtensionAPI);
  try {
    handlers.get("session_start")!({}, ctx);
    stale = true;
    await vi.advanceTimersByTimeAsync(0);
    expect(requestRender).toHaveBeenCalledOnce();
    expect(exec).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(exec).toHaveBeenCalledTimes(3);
    expect(handlers.has("tool_execution_end")).toBe(false);
    expect(handlers.has("agent_end")).toBe(false);

    // Notifications and unrelated working-copy metadata writes need no jj queries.
    writeFileSync(join(workingCopy, "tree_state"), "unrelated");
    for (const callback of callbacks) callback();
    await vi.advanceTimersByTimeAsync(500);
    expect(exec).toHaveBeenCalledTimes(3);

    bookmark = "feature/footer";
    writeFileSync(join(heads, "b"), "");
    for (const callback of callbacks) callback();
    await vi.advanceTimersByTimeAsync(250);
    for (const callback of callbacks) callback();
    await vi.advanceTimersByTimeAsync(499);
    expect(exec).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(exec).toHaveBeenCalledTimes(5);
    expect(exec.mock.calls.filter(([, args]) => args.includes("root"))).toHaveLength(1);

    let resolvePending!: (result: any) => void;
    exec.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePending = resolve;
        }),
    );
    writeFileSync(join(heads, "c"), "");
    for (const callback of callbacks) callback();
    await vi.advanceTimersByTimeAsync(500);
    expect(exec).toHaveBeenCalledTimes(7);
    // Changes during an in-flight read must not be dropped.
    writeFileSync(join(heads, "d"), "");
    for (const callback of callbacks) callback();
    await vi.advanceTimersByTimeAsync(500);
    expect(exec).toHaveBeenCalledTimes(7);
    resolvePending({ code: 0, stdout: "qu", stderr: "", killed: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(exec).toHaveBeenCalledTimes(9);

    exec.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePending = resolve;
        }),
    );
    writeFileSync(join(heads, "e"), "");
    for (const callback of callbacks) callback();
    await vi.advanceTimersByTimeAsync(500);
    handlers.get("session_shutdown")!();
    requestRender.mockClear();
    resolvePending({ code: 0, stdout: "/other", stderr: "", killed: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(requestRender).not.toHaveBeenCalled();
    expect(component!.render(100)).toEqual([]);
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledTimes(2);
    const disposedCalls = exec.mock.calls.length;
    for (const callback of callbacks) callback();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(exec).toHaveBeenCalledTimes(disposedCalls);
  } finally {
    handlers.get("session_shutdown")!();
    vi.mocked(watch).mockReset();
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  }
});

test.each([false, true])(
  "metadata-only fallback polling supports nested heads=%s",
  async (nested) => {
    vi.useFakeTimers();
    const dir = mkdtempSync(join(tmpdir(), "pi-footer-fallback-"));
    const heads = join(dir, ".jj", "repo", "op_heads", ...(nested ? ["heads"] : []));
    const checkout = join(dir, ".jj", "working_copy", "checkout");
    mkdirSync(heads, { recursive: true });
    mkdirSync(join(dir, ".jj", "working_copy"), { recursive: true });
    writeFileSync(join(heads, "a"), "");
    writeFileSync(checkout, "initial");
    vi.mocked(watch).mockImplementation(() => {
      throw new Error("watch unavailable");
    });
    const changed = vi.fn();
    const stop = watchJjMetadata(dir, changed);
    try {
      await vi.advanceTimersByTimeAsync(60_000);
      expect(changed).not.toHaveBeenCalled();
      writeFileSync(checkout, "changed");
      await vi.advanceTimersByTimeAsync(5_000);
      expect(changed).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(changed).toHaveBeenCalledOnce();
      stop();
      writeFileSync(join(heads, "b"), "");
      await vi.advanceTimersByTimeAsync(5_000);
      expect(changed).toHaveBeenCalledOnce();
    } finally {
      stop();
      vi.mocked(watch).mockReset();
      vi.useRealTimers();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("additional workspaces watch shared operation heads and their own checkout", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-footer-workspace-"));
  const mainHeads = join(dir, "main", ".jj", "repo", "op_heads", "heads");
  const workspace = join(dir, "other");
  const workingCopy = join(workspace, ".jj", "working_copy");
  mkdirSync(mainHeads, { recursive: true });
  mkdirSync(workingCopy, { recursive: true });
  writeFileSync(join(workspace, ".jj", "repo"), "../../main/.jj/repo");
  writeFileSync(join(workingCopy, "checkout"), "initial");
  vi.mocked(watch).mockImplementation(
    () => ({ on: () => undefined, close: () => {} }) as unknown as FSWatcher,
  );
  const stop = watchJjMetadata(workspace, () => {});
  try {
    expect(vi.mocked(watch).mock.calls.map(([directory]) => directory)).toEqual([
      mainHeads,
      workingCopy,
    ]);
  } finally {
    stop();
    vi.mocked(watch).mockReset();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildExtensionStatusLines gives session tracker its own line", () => {
  expect(
    buildExtensionStatusLines(
      new Map([
        ["token-count", "codex: 5h: 4%"],
        ["session-tracker", "pi-sessions: 1 · 1 idle"],
      ]),
      120,
    ),
  ).toEqual(["codex: 5h: 4%", "pi-sessions: 1 · 1 idle"]);
});

test("SubagentUsageReader includes existing usage for its parent session", () => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = mkdtempSync(join(tmpdir(), "pi-bites-footer-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;

  try {
    const usageDir = join(agentDir, "pi-bites", "usage");
    mkdirSync(usageDir, { recursive: true });
    const usageFile = join(usageDir, "explore.jsonl");
    writeFileSync(
      usageFile,
      [
        {
          type: "subagent_usage",
          subagent: "explore",
          sessionId: "agent-1",
          parentSessionId: "parent-1",
          timestamp: 1,
          provider: "anthropic",
          model: "claude",
          usage: { input: 2, output: 3, cacheRead: 5, cost: 0.01 },
        },
        {
          type: "automode_usage",
          version: 1,
          parentSessionId: "parent-1",
          timestamp: 2,
          provider: "anthropic",
          model: "claude",
          usage: { input: 100, output: 100, cacheRead: 100, cost: { total: 1 } },
        },
      ]
        .map((record) => JSON.stringify(record))
        .join("\n") + "\n",
    );

    const reader = new SubagentUsageReader("parent-1");

    expect(reader.readNewUsage()).toEqual({
      input: 2,
      output: 3,
      cacheRead: 5,
      cacheWrite: 0,
      cost: 0.01,
    });
  } finally {
    rmSync(agentDir, { recursive: true, force: true });

    if (previousAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  }
});

test("SubagentUsageReader only counts subagents owned by its parent session", () => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = mkdtempSync(join(tmpdir(), "pi-bites-footer-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;

  try {
    const usageDir = join(agentDir, "pi-bites", "usage");
    mkdirSync(usageDir, { recursive: true });
    const usageFile = join(usageDir, "subagents.jsonl");
    writeFileSync(usageFile, "");

    const owningReader = new SubagentUsageReader("parent-1");
    const idleReader = new SubagentUsageReader("parent-2");

    appendFileSync(
      usageFile,
      [
        {
          type: "subagent_usage",
          subagent: "general-purpose",
          sessionId: "general-1",
          parentSessionId: "parent-1",
          timestamp: 1,
          provider: "anthropic",
          model: "claude",
          usage: {
            input: 7,
            output: 8,
            cacheRead: 9,
            cacheWrite: 10,
            cost: { total: 0.02 },
          },
        },
        {
          type: "subagent_usage",
          subagent: "explore",
          sessionId: "legacy-agent",
          usage: { input: 100, output: 100, cacheRead: 100, cost: 1 },
        },
      ]
        .map((record) => JSON.stringify(record))
        .join("\n") + "\n",
    );

    expect(owningReader.readNewUsage()).toEqual({
      input: 7,
      output: 8,
      cacheRead: 9,
      cacheWrite: 10,
      cost: 0.02,
    });
    expect(idleReader.readNewUsage()).toEqual(usage());
  } finally {
    rmSync(agentDir, { recursive: true, force: true });

    if (previousAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  }
});

test("buildFooterLine truncates on narrow terminals", () => {
  const ctx: any = {
    cwd: "/very/long/path/to/project",
    model: { provider: "provider", id: "model", contextWindow: 100_000 },
    getContextUsage: () => ({ tokens: 10_000, contextWindow: 100_000, percent: 10 }),
    sessionManager: { getBranch: () => [], getEntries: () => [] },
  };

  const line = buildFooterLine(ctx, footerData, usage(), 30);
  expect(visibleWidth(line)).toBeLessThanOrEqual(30);
});
