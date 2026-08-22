import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentManager, MAX_RETAINED_TOOL_CALLS } from "../agent-manager.js";

vi.mock("../agent-runner.js", () => ({
  runAgent: vi.fn(),
  resumeAgent: vi.fn(),
}));

vi.mock("../worktree.js", () => ({
  createWorktree: vi.fn(),
  cleanupWorktree: vi.fn(() => ({ hasChanges: false })),
  pruneWorktrees: vi.fn(),
}));

vi.mock("../usage.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../usage.js")>()),
  appendSubagentUsageRecord: vi.fn(() => Promise.resolve()),
}));

import { runAgent } from "../agent-runner.js";
import { appendSubagentUsageRecord } from "../usage.js";

const mockPi = { events: { emit: vi.fn() } } as any;
const mockCtx = {
  cwd: "/tmp",
  model: undefined,
  getSystemPrompt: () => "parent prompt",
  modelRegistry: {
    getAvailable: () => [],
    getRegisteredProviderIds: () => [],
    getRegisteredProviderConfig: () => undefined,
  },
  sessionManager: { getSessionId: () => "parent-session", getBranch: () => [] },
} as any;

const mockSession = () => ({ dispose: vi.fn() }) as any;

const resolvedRun = () =>
  vi.mocked(runAgent).mockResolvedValue({
    responseText: "done",
    session: mockSession(),
  });

describe("AgentManager — detached lifecycle", () => {
  let manager: AgentManager;
  afterEach(() => manager.dispose());

  it("keeps the raw spawn prompt on the agent record", () => {
    manager = new AgentManager();
    vi.mocked(runAgent).mockReturnValue(new Promise(() => {}));

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "raw task", {
      description: "task",
      inheritContext: true,
    });

    expect(manager.getRecord(id)?.prompt).toBe("raw task");
  });

  it("snapshots a queued agent's parent context before the extension context goes stale", async () => {
    manager = new AgentManager(undefined, 1);
    let resolveFirst!: (value: { responseText: string; session: any }) => void;
    vi.mocked(runAgent)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce({ responseText: "second", session: mockSession() });

    let stale = false;
    const parent = {
      get cwd() {
        if (stale) throw new Error("stale ctx");
        return "/tmp";
      },
      get model() {
        if (stale) throw new Error("stale ctx");
        return undefined;
      },
      get modelRegistry() {
        if (stale) throw new Error("stale ctx");
        return mockCtx.modelRegistry;
      },
      getSystemPrompt: () => {
        if (stale) throw new Error("stale ctx");
        return "parent prompt";
      },
      sessionManager: mockCtx.sessionManager,
    } as any;

    const first = manager.spawn(mockPi, parent, "general-purpose", "first", {
      description: "first",
    });
    const second = manager.spawn(mockPi, parent, "general-purpose", "second", {
      description: "second",
    });
    stale = true;
    resolveFirst({ responseText: "first", session: mockSession() });

    await manager.getRecord(first)!.promise;
    await vi.waitFor(() => expect(manager.getRecord(second)?.status).toBe("completed"));
    expect(vi.mocked(runAgent).mock.calls[1]?.[0]).toMatchObject({
      cwd: "/tmp",
      sessionId: "parent-session",
      systemPrompt: "parent prompt",
    });
  });

  it("emits created with a stable identity for every spawn", () => {
    const pi = { events: { emit: vi.fn() } } as any;
    manager = new AgentManager();
    vi.mocked(runAgent).mockReturnValue(new Promise(() => {}));

    const id = manager.spawn(pi, mockCtx, "general-purpose", "task", { description: "task" });

    expect(pi.events.emit).toHaveBeenCalledWith("subagents:created", {
      id,
      type: "general-purpose",
      description: "task",
    });
  });

  it("fixes child messages to the spawning parent and sender identity", () => {
    const messageParent = vi.fn(() => true);
    manager = new AgentManager(undefined, 4, undefined, undefined, messageParent);
    vi.mocked(runAgent).mockReturnValue(new Promise(() => {}));

    const id = manager.spawn(mockPi, mockCtx, "explore", "task", {
      description: "trace auth flow",
    });
    const transport = vi.mocked(runAgent).mock.calls.at(-1)?.[3].messageParent;

    expect(transport?.("found it")).toBe(true);
    expect(messageParent).toHaveBeenCalledWith(
      "parent-session",
      { id, type: "explore", title: "trace auth flow" },
      "found it",
    );
  });
});

describe("AgentManager — completion callbacks", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager.dispose();
  });

  it("does not let onComplete errors turn a completed agent into a failed run", async () => {
    manager = new AgentManager(() => {
      throw new Error("stale extension context");
    });
    resolvedRun();

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
    });
    await expect(manager.getRecord(id)!.promise).resolves.toBe("done");

    expect(manager.getRecord(id)!.status).toBe("completed");
  });
});

describe("AgentManager — cleanup timer", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager.dispose();
  });

  it("does not keep the process alive on its own", () => {
    manager = new AgentManager();

    expect((manager as any).cleanupInterval.hasRef()).toBe(false);
  });
});

describe("AgentManager — Bug 3 clearCompleted", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager.dispose();
  });

  it("clearCompleted removes completed records", async () => {
    manager = new AgentManager();
    resolvedRun();

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
    });
    await manager.getRecord(id)!.promise;

    expect(manager.listAgents()).toHaveLength(1);
    manager.clearCompleted();
    expect(manager.listAgents()).toHaveLength(0);
  });

  it("clearCompleted does not remove running or queued agents", async () => {
    // With one concurrency slot, the second agent stays queued behind the first.
    manager = new AgentManager(undefined, 1);

    // Mock runAgent to never resolve (keeps agent "running")
    vi.mocked(runAgent).mockImplementation(
      () => new Promise(() => {}), // hangs forever
    );

    const id1 = manager.spawn(mockPi, mockCtx, "general-purpose", "test1", {
      description: "running agent",
    });
    // Second agent should be queued (limit=1)
    const id2 = manager.spawn(mockPi, mockCtx, "general-purpose", "test2", {
      description: "queued agent",
    });

    expect(manager.getRecord(id1)!.status).toBe("running");
    expect(manager.getRecord(id2)!.status).toBe("queued");

    manager.clearCompleted();

    // Both should still be present
    expect(manager.getRecord(id1)).toBeDefined();
    expect(manager.getRecord(id2)).toBeDefined();

    // Abort to allow cleanup
    manager.abort(id1);
    manager.abort(id2);
  });

  it("clearCompleted calls dispose on sessions of removed records", async () => {
    manager = new AgentManager();
    const disposeSpy = vi.fn();
    const sess = { dispose: disposeSpy };
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "done",
      session: sess as any,
    });

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
    });
    await manager.getRecord(id)!.promise;

    manager.clearCompleted();

    expect(disposeSpy).toHaveBeenCalledOnce();
  });

  it("clearCompleted removes error and stopped records", async () => {
    manager = new AgentManager();
    vi.mocked(runAgent).mockRejectedValue(new Error("boom"));

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
    });
    await manager.getRecord(id)!.promise;
    expect(manager.getRecord(id)!.status).toBe("error");

    manager.clearCompleted();
    expect(manager.getRecord(id)).toBeUndefined();
  });
});

// Eager init removes the optional/required asymmetry that previously required
// `??=` defaults at the callback sites and `?? 0` / `?? 1` at the read sites.
describe("AgentManager — lifetime usage + compaction count are eagerly initialized", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager.dispose();
  });

  it("spawn initializes lifetimeUsage to zeros and compactionCount to 0", () => {
    manager = new AgentManager();
    // Don't resolve the run — we just want to inspect the record at spawn time.
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
    });
    const record = manager.getRecord(id)!;

    expect(record.lifetimeUsage).toEqual({ input: 0, output: 0, cacheWrite: 0 });
    expect(record.compactionCount).toBe(0);

    manager.abort(id);
  });

  it("onAssistantUsage from runAgent accumulates into record.lifetimeUsage", async () => {
    manager = new AgentManager();

    // Capture the options passed to runAgent so we can drive callbacks
    let captured: any;
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts: any) => {
      captured = opts;
      // Two assistant messages with usage
      opts.onAssistantUsage?.({ input: 100, output: 50, cacheWrite: 10 });
      opts.onAssistantUsage?.({ input: 200, output: 80, cacheWrite: 20 });
      return { responseText: "done", session: mockSession() };
    });

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
    });
    await manager.getRecord(id)!.promise;

    expect(captured).toBeDefined();
    expect(manager.getRecord(id)!.lifetimeUsage).toEqual({
      input: 300,
      output: 130,
      cacheWrite: 30,
    });
  });

  it("onCompaction from runAgent increments record.compactionCount", async () => {
    manager = new AgentManager();
    const compactSeen: any[] = [];

    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts: any) => {
      // Compaction fires while the agent is still running — the record passed to
      // onCompact should reflect the just-incremented count.
      opts.onCompaction?.({ reason: "threshold", tokensBefore: 12345 });
      opts.onCompaction?.({ reason: "manual", tokensBefore: 22222 });
      return { responseText: "done", session: mockSession() };
    });

    manager = new AgentManager(undefined, undefined, undefined, (record, info) => {
      compactSeen.push({ count: record.compactionCount, reason: info.reason });
    });

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
    });
    await manager.getRecord(id)!.promise;

    expect(compactSeen).toEqual([
      { count: 1, reason: "threshold" },
      { count: 2, reason: "manual" },
    ]);
    expect(manager.getRecord(id)!.compactionCount).toBe(2);
  });

  it("cancel-and-steer persists resumed usage and tool calls", async () => {
    manager = new AgentManager();
    const session = { ...mockSession(), abort: vi.fn(() => Promise.resolve()) };
    let finishInitialRun!: () => void;

    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts: any) => {
      opts.onSessionCreated?.(session);
      for (let index = 0; index < MAX_RETAINED_TOOL_CALLS + 2; index++) {
        opts.onToolActivity?.({
          type: "call",
          toolName: "bash",
          arguments: { command: `echo initial-${index}` },
        });
      }
      await new Promise<void>((resolve) => {
        finishInitialRun = resolve;
      });
      return { responseText: "first", session: session as any };
    });
    const { resumeAgent: resumeMock } = await import("../agent-runner.js");
    vi.mocked(resumeMock).mockImplementation(async (_session, _prompt, opts: any) => {
      opts.onAssistantUsage?.({ input: 12, output: 3, cacheWrite: 1 });
      opts.onToolActivity?.({
        type: "call",
        toolName: "read",
        arguments: { path: "resumed.ts" },
      });
      return "second";
    });

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
    });
    expect(manager.cancelAndSteer(id, "change course")).toBe(true);
    vi.mocked(appendSubagentUsageRecord).mockClear();
    finishInitialRun();
    await manager.getRecord(id)!.promise;

    expect(appendSubagentUsageRecord).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: id, parentSessionId: "parent-session" }),
    );
    expect(manager.getRecord(id)!.toolCalls).toHaveLength(MAX_RETAINED_TOOL_CALLS);
    expect(manager.getRecord(id)!.toolCalls[0]).toBe("Bash(echo initial-3)");
    expect(manager.getRecord(id)!.toolCalls.at(-1)).toBe("Read(resumed.ts)");
    expect(manager.getRecord(id)!.omittedToolCalls).toBe(3);
  });
});

// Regression: `isolation: "worktree"` MUST fail loud when the cwd can't host
// a worktree. The previous behavior silently fell back to the main tree and
// injected a warning into the LLM's prompt — invisible to the caller.
describe("AgentManager — isolation: worktree fails loud, no silent fallback", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager.dispose();
  });

  it("spawn() throws when createWorktree returns undefined; no orphan record left behind", async () => {
    const { createWorktree } = await import("../worktree.js");
    vi.mocked(createWorktree).mockReturnValueOnce(undefined);
    vi.mocked(runAgent).mockClear();

    manager = new AgentManager();
    expect(() =>
      manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
        description: "test",
        isolation: "worktree",
      }),
    ).toThrow(/isolation: "worktree"/);

    // Cleaned up — no orphan in listAgents()
    expect(manager.listAgents()).toEqual([]);
    // runAgent never invoked — strict, no silent fallback
    expect(runAgent).not.toHaveBeenCalled();
  });
});

describe("AgentManager — SpawnOptions.cwd passthrough (#96)", () => {
  let manager: AgentManager;
  afterEach(() => manager.dispose());

  it("passes cwd to runAgent as the working dir, parent cwd as configCwd", async () => {
    resolvedRun();
    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      cwd: "/", // absolute and always exists
    });
    await manager.getRecord(id)!.promise;

    expect(runAgent).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/tmp", sessionId: "parent-session" }),
      "general-purpose",
      "test",
      expect.objectContaining({ cwd: "/", configCwd: "/tmp" }),
    );
  });

  it("without cwd, configCwd stays unset — existing behavior untouched", async () => {
    // mockClear + lastCall: toHaveBeenCalledWith would scan the file's whole
    // accumulated call history, where earlier no-cwd spawns already match.
    vi.mocked(runAgent).mockClear();
    resolvedRun();
    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
    });
    await manager.getRecord(id)!.promise;

    const opts = vi.mocked(runAgent).mock.lastCall![3];
    expect(opts.cwd).toBeUndefined();
    expect(opts.configCwd).toBeUndefined();
  });

  it("cwd: null (RPC 'unset') behaves exactly like omitting cwd", async () => {
    vi.mocked(runAgent).mockClear();
    resolvedRun();
    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      cwd: null as any,
    });
    await manager.getRecord(id)!.promise;

    const opts = vi.mocked(runAgent).mock.lastCall![3];
    expect(opts.cwd).toBeUndefined();
    expect(opts.configCwd).toBeUndefined();
  });

  it("cwd + isolation: worktree — worktree created FROM cwd, session runs at the copy's workPath, cleanup targets cwd's repo", async () => {
    const { createWorktree, cleanupWorktree } = await import("../worktree.js");
    vi.mocked(createWorktree).mockReturnValueOnce({
      path: "/wt/copy",
      branch: "pi-agent-x",
      baseSha: "abc",
      workPath: "/wt/copy/packages/api",
    });
    resolvedRun();

    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      cwd: "/",
      isolation: "worktree",
    });
    await manager.getRecord(id)!.promise;

    expect(createWorktree).toHaveBeenCalledWith("/", id);
    // Worktree wins for the working dir — at workPath, so subdirectory scoping
    // survives isolation. Config still anchored to the parent.
    expect(runAgent).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/tmp", sessionId: "parent-session" }),
      "general-purpose",
      "test",
      expect.objectContaining({ cwd: "/wt/copy/packages/api", configCwd: "/tmp" }),
    );
    expect(cleanupWorktree).toHaveBeenCalledWith("/", expect.anything(), "test");
  });

  it("plain worktree (no cwd) keeps the historical root working dir even when workPath differs", async () => {
    // Parent session sitting in a repo subdirectory: workPath would point at
    // the copied subdir. Without SpawnOptions.cwd the agent must stay at the
    // copy's root — moving it would also move .pi config discovery.
    const { createWorktree } = await import("../worktree.js");
    vi.mocked(createWorktree).mockReturnValueOnce({
      path: "/wt/copy",
      branch: "pi-agent-x",
      baseSha: "abc",
      workPath: "/wt/copy/sub/dir",
    });
    vi.mocked(runAgent).mockClear();
    resolvedRun();

    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isolation: "worktree",
    });
    await manager.getRecord(id)!.promise;

    const opts = vi.mocked(runAgent).mock.lastCall![3];
    expect(opts.cwd).toBe("/wt/copy");
    expect(opts.configCwd).toBeUndefined();
  });

  it("relative cwd throws immediately; no orphan record", () => {
    vi.mocked(runAgent).mockClear();
    manager = new AgentManager();
    expect(() =>
      manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
        description: "test",
        cwd: "relative/path",
      }),
    ).toThrow(/absolute path/);
    expect(manager.listAgents()).toEqual([]);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("nonexistent cwd throws immediately; no orphan record", () => {
    vi.mocked(runAgent).mockClear();
    manager = new AgentManager();
    expect(() =>
      manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
        description: "test",
        cwd: "/nonexistent-pi-subagents-test-dir",
      }),
    ).toThrow(/does not exist/);
    expect(manager.listAgents()).toEqual([]);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("cwd pointing at a regular file throws a curated 'not a directory' error", () => {
    vi.mocked(runAgent).mockClear();
    manager = new AgentManager();
    expect(() =>
      manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
        description: "test",
        cwd: fileURLToPath(import.meta.url), // this test file: absolute, exists, not a directory
      }),
    ).toThrow(/not a directory/);
    expect(manager.listAgents()).toEqual([]);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("non-string cwd (RPC junk) throws the curated error, not a TypeError from path internals", () => {
    vi.mocked(runAgent).mockClear();
    manager = new AgentManager();
    expect(() =>
      manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
        description: "test",
        cwd: 123 as any,
      }),
    ).toThrow(/must be an absolute path/);
    expect(manager.listAgents()).toEqual([]);
  });
});

describe("AgentManager — abort() state machine", () => {
  let manager: AgentManager;
  afterEach(() => manager.dispose());

  it("returns false for an unknown id (no record, no side-effects)", () => {
    manager = new AgentManager();
    expect(manager.abort("does-not-exist")).toBe(false);
  });

  it("removes a queued agent from the queue and marks it stopped", () => {
    // Concurrency=1: the second spawn queues behind the first
    manager = new AgentManager(undefined, 1);
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));

    manager.spawn(mockPi, mockCtx, "X", "blocker", { description: "block" });
    const queuedId = manager.spawn(mockPi, mockCtx, "Y", "queued", {
      description: "q",
    });
    const queuedRecord = manager.getRecord(queuedId)!;
    expect(queuedRecord.status).toBe("queued");

    expect(manager.abort(queuedId)).toBe(true);
    expect(queuedRecord.status).toBe("stopped");
    expect(queuedRecord.completedAt).toBeGreaterThan(0);
    // Aborting again is a no-op — status is no longer "queued" or "running"
    expect(manager.abort(queuedId)).toBe(false);
  });

  it("aborts a running agent by firing its AbortController and setting status='stopped'", () => {
    manager = new AgentManager();
    let receivedSignal: AbortSignal | undefined;
    vi.mocked(runAgent).mockImplementation((_ctx, _type, _prompt, opts) => {
      receivedSignal = (opts as { signal?: AbortSignal }).signal;
      return new Promise(() => {});
    });

    const id = manager.spawn(mockPi, mockCtx, "X", "p", {
      description: "r",
    });
    const record = manager.getRecord(id)!;
    expect(record.status).toBe("running");
    expect(receivedSignal?.aborted).toBe(false);

    expect(manager.abort(id)).toBe(true);
    expect(record.status).toBe("stopped");
    expect(record.completedAt).toBeGreaterThan(0);
    expect(receivedSignal?.aborted).toBe(true);
  });

  it("returns false (and does not change status) for an already-completed agent", async () => {
    manager = new AgentManager();
    resolvedRun();
    const id = manager.spawn(mockPi, mockCtx, "X", "p", {
      description: "x",
    });
    await manager.getRecord(id)?.promise;
    expect(manager.getRecord(id)?.status).toBe("completed");

    expect(manager.abort(id)).toBe(false);
    expect(manager.getRecord(id)?.status).toBe("completed");
  });

  it("a user abort survives the agent settling — stays 'stopped', never 'completed'", async () => {
    // Guards the `if (record.status !== "stopped")` check in the completion
    // handler: after a user abort, runAgent's promise still settles (here with
    // as a non-cooperative mock would), and must NOT flip the
    // user-stopped status back to "completed" — otherwise the parent agent
    // would read the partial output as a finished result.
    const onComplete = vi.fn();
    manager = new AgentManager(onComplete);
    let resolveRun!: (v: unknown) => void;
    vi.mocked(runAgent).mockImplementation(
      () =>
        new Promise((res) => {
          resolveRun = res as (v: unknown) => void;
        }),
    );

    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "r" });
    const record = manager.getRecord(id)!;
    expect(record.status).toBe("running");

    expect(manager.abort(id)).toBe(true);
    expect(record.status).toBe("stopped");
    expect(onComplete).toHaveBeenCalledOnce();
    expect(onComplete).toHaveBeenCalledWith(record);

    manager.clearCompleted();
    expect(manager.getRecord(id)).toBe(record);

    // The agent loop ends and the promise settles "normally".
    resolveRun({
      responseText: "partial output",
      session: mockSession(),
    });
    await record.promise;

    expect(record.status).toBe("stopped"); // not overwritten to "completed"
    expect(record.result).toBe("partial output"); // partial result still captured
    expect(onComplete).toHaveBeenCalledOnce();
    expect((manager as any).runningCount).toBe(0);

    manager.clearCompleted();
    expect(manager.getRecord(id)).toBeUndefined();
  });
});

describe("AgentManager — steer()", () => {
  let manager: AgentManager;
  afterEach(() => manager.dispose());

  it("returns false for an unknown id", () => {
    manager = new AgentManager();
    expect(manager.steer("nope", "hi")).toBe(false);
  });

  it("delivers to a live session via session.steer()", () => {
    manager = new AgentManager();
    const steer = vi.fn(() => Promise.resolve());
    let captured: ((s: any) => void) | undefined;
    vi.mocked(runAgent).mockImplementation((_ctx, _type, _prompt, opts) => {
      captured = (opts as any)?.onSessionCreated;
      return new Promise(() => {});
    });
    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "r" });
    // Simulate the session becoming ready.
    captured?.({ steer, dispose: vi.fn(), isStreaming: true });

    expect(manager.steer(id, "go left")).toBe(true);
    expect(steer).toHaveBeenCalledWith("go left");
  });

  it("queues onto pendingSteers when the session isn't ready yet", () => {
    manager = new AgentManager();
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "r" });
    const record = manager.getRecord(id)!;
    record.session = undefined; // not ready

    expect(manager.steer(id, "first")).toBe(true);
    expect(manager.steer(id, "second")).toBe(true);
    expect(record.pendingSteers).toEqual(["first", "second"]);
  });

  it("rejects a message to a completed session", async () => {
    manager = new AgentManager();
    resolvedRun();
    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "x" });
    await manager.getRecord(id)?.promise;

    expect(manager.getRecord(id)?.status).toBe("completed");
    expect(manager.steer(id, "keep going")).toBe(false);
  });
});

describe("AgentManager — listAgents() ordering", () => {
  let manager: AgentManager;
  afterEach(() => manager.dispose());

  it("returns records sorted by startedAt descending (most recent first)", () => {
    manager = new AgentManager();
    resolvedRun();

    const a = manager.spawn(mockPi, mockCtx, "X", "1", { description: "a" });
    const b = manager.spawn(mockPi, mockCtx, "X", "2", { description: "b" });
    const c = manager.spawn(mockPi, mockCtx, "X", "3", { description: "c" });

    // Force deterministic startedAt — Date.now() can collide on fast runs
    manager.getRecord(a)!.startedAt = 100;
    manager.getRecord(b)!.startedAt = 200;
    manager.getRecord(c)!.startedAt = 300;

    expect(manager.listAgents().map((r) => r.id)).toEqual([c, b, a]);
  });
});

describe("AgentManager — abortAll", () => {
  let manager: AgentManager;
  afterEach(() => manager.dispose());

  it("stops both queued and running agents and returns the total count", () => {
    manager = new AgentManager(undefined, 1);
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));

    const running = manager.spawn(mockPi, mockCtx, "X", "r", {
      description: "r",
    });
    const queued = manager.spawn(mockPi, mockCtx, "Y", "q", {
      description: "q",
    });
    expect(manager.getRecord(running)?.status).toBe("running");
    expect(manager.getRecord(queued)?.status).toBe("queued");

    expect(manager.abortAll()).toBe(2);
    expect(manager.getRecord(running)?.status).toBe("stopped");
    expect(manager.getRecord(queued)?.status).toBe("stopped");
    expect(manager.hasRunning()).toBe(false);
  });

  it("returns 0 when there are no running or queued agents", () => {
    manager = new AgentManager();
    expect(manager.abortAll()).toBe(0);
  });
});

describe("AgentManager — hasRunning", () => {
  let manager: AgentManager;
  afterEach(() => manager.dispose());

  it("is true while an agent is running, false after it completes", async () => {
    manager = new AgentManager();
    resolvedRun();

    expect(manager.hasRunning()).toBe(false);
    const id = manager.spawn(mockPi, mockCtx, "X", "p", {
      description: "x",
    });
    expect(manager.hasRunning()).toBe(true);

    await manager.getRecord(id)?.promise;
    expect(manager.hasRunning()).toBe(false);
  });

  it("is true when an agent is queued behind the concurrency limit", () => {
    manager = new AgentManager(undefined, 1);
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));

    manager.spawn(mockPi, mockCtx, "X", "r", { description: "r" });
    manager.spawn(mockPi, mockCtx, "Y", "q", { description: "q" });
    expect(manager.hasRunning()).toBe(true);
  });
});

describe("AgentManager — runAgent rejection leaves the record visible with error status", () => {
  let manager: AgentManager;
  afterEach(() => manager.dispose());

  it("sets status='error', captures the error message, and stamps completedAt", async () => {
    manager = new AgentManager();
    vi.mocked(runAgent).mockRejectedValue(new Error("boom"));

    const id = manager.spawn(mockPi, mockCtx, "X", "p", {
      description: "x",
    });
    const record = manager.getRecord(id)!;
    await record.promise;

    expect(record.status).toBe("error");
    expect(record.error).toBe("boom");
    expect(record.completedAt).toBeGreaterThan(0);
  });
});
