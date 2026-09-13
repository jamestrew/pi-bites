import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { AgentManager } from "../agent-manager.js";
import { createAgentCompletionHandler } from "../agent-completion.js";
import { mockCtx, mockPi, mockSession } from "./helpers/agent-manager-mocks.js";

vi.mock("../agent-runner.js", () => ({
  runAgent: vi.fn(),
  openAgentSession: vi.fn(),
  resumeAgent: vi.fn(),
}));
vi.mock("../diagnostics.js", async (original) => ({
  ...(await original<typeof import("../diagnostics.js")>()),
  appendSubagentDiagnostic: vi.fn(async () => {}),
}));
import { openAgentSession, runAgent, resumeAgent } from "../agent-runner.js";

const model = { id: "current", provider: "test", reasoning: false } as any;
const pi = { ...mockPi, getActiveTools: () => ["read"], getThinkingLevel: () => "off" } as any;
const ctx = {
  ...mockCtx,
  model,
  scopedModels: [],
  modelRegistry: { ...mockCtx.modelRegistry, getAvailable: () => [model] },
} as any;
let manager: AgentManager;
beforeEach(() => {
  vi.resetAllMocks();
  manager = new AgentManager(undefined, 1);
});
afterEach(async () => {
  await manager.dispose();
});

async function closedAgent() {
  const sessionManager = SessionManager.inMemory("/tmp", { id: "child-session" });
  sessionManager.appendMessage({ role: "user", content: "blue door", timestamp: 1 });
  sessionManager.appendCustomEntry("approval", { allow: "all" });
  vi.mocked(runAgent).mockResolvedValueOnce({
    session: { ...mockSession(), sessionManager },
    responseText: "remembered",
  });
  const id = manager.spawn(pi, ctx, "worker", "remember", { description: "memory" });
  await manager.getRecord(id)!.promise;
  await manager.close(id);
  return id;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

it("reopens the owned identity without a task, retains capacity and completes selected input", async () => {
  const completion = createAgentCompletionHandler({
    pi,
    getRecord: (id) => manager.getRecord(id),
    onAgentFinishedUI: () => {},
  });
  await manager.dispose();
  manager = new AgentManager(completion.onAgentComplete, 1);
  const id = await closedAgent();
  vi.mocked(openAgentSession).mockImplementation(async (_parent, _type, options) => {
    const saved = options.conversation!;
    return {
      ...mockSession(),
      sessionManager: SessionManager.inMemory(saved.cwd, {}, saved.entries),
    };
  });
  expect(await manager.reopen(pi, ctx, id)).toBe("pending_init");
  const record = manager.getRecord(id)!;
  expect(record.parentSessionId).toBe("parent-session");
  expect(record.type).toBe("worker");
  expect(record.session!.sessionManager.getSessionId()).toBe("child-session");
  expect(record.session!.sessionManager.buildSessionContext().messages).toEqual([
    { role: "user", content: "blue door", timestamp: 1 },
  ]);
  expect(record.session!.sessionManager.getEntries().some((entry) => entry.type === "custom")).toBe(
    false,
  );
  expect(resumeAgent).not.toHaveBeenCalled();
  expect(manager.getClosedRecord(id)).toBeUndefined();
  expect(() => manager.spawn(pi, ctx, "worker", "another", { description: "another" })).toThrow(
    "concurrency",
  );
  expect(await manager.reopen(pi, ctx, id)).toBe("pending_init");
  expect(openAgentSession).toHaveBeenCalledOnce();
  const waiting = completion.waitFor([id], 10_000);
  vi.mocked(resumeAgent).mockResolvedValueOnce("blue door remembered");
  expect(await manager.sendInput(id, "what door?")).toBe(true);
  await record.promise;
  const waited = await waiting;
  expect(waited).toMatchObject({ status: { [id]: { completed: "blue door remembered" } } });
  await manager.close(id);
  expect(manager.getRecord(id)).toBeUndefined();
  expect(await manager.reopen(pi, ctx, id)).toBe("pending_init");
  completion.dispose();
});

it("claims capacity before loading and serializes concurrent resumes", async () => {
  const id = await closedAgent();
  const loading = deferred<any>();
  vi.mocked(openAgentSession).mockReturnValue(loading.promise);
  const first = manager.reopen(pi, ctx, id);
  const second = manager.reopen(pi, ctx, id);
  expect(() => manager.spawn(pi, ctx, "worker", "another", { description: "another" })).toThrow(
    "concurrency",
  );
  await Promise.resolve();
  expect(openAgentSession).toHaveBeenCalledOnce();
  loading.resolve(mockSession());
  expect(await first).toBe("pending_init");
  expect(await second).toBe("pending_init");
});

it("fails at capacity before loading, and failed reopen can retry without leaking slots", async () => {
  const id = await closedAgent();
  vi.mocked(runAgent).mockResolvedValueOnce({ session: mockSession(), responseText: "done" });
  const blocker = manager.spawn(pi, ctx, "worker", "blocker", { description: "blocker" });
  await expect(manager.reopen(pi, ctx, id)).rejects.toThrow("concurrency");
  expect(openAgentSession).not.toHaveBeenCalled();
  await manager.getRecord(blocker)!.promise;
  await manager.close(blocker);
  vi.mocked(openAgentSession).mockRejectedValueOnce(new Error("corrupt data"));
  await expect(manager.reopen(pi, ctx, id)).rejects.toThrow("corrupt data");
  expect(manager.getClosedRecord(id)?.recoverable).toBe(true);
  vi.mocked(openAgentSession).mockResolvedValueOnce(mockSession());
  expect(await manager.reopen(pi, ctx, id)).toBe("pending_init");
});

it("rejects unknown, unrecoverable, foreign-owned, corrupt and unauthorized state before loading", async () => {
  await expect(manager.reopen(pi, ctx, "/tmp/arbitrary.jsonl")).rejects.toThrow("not found");
  const id = await closedAgent();
  await expect(
    manager.reopen(pi, { ...ctx, sessionManager: { getSessionId: () => "other" } }, id),
  ).rejects.toThrow("not owned");
  await expect(
    manager.reopen(
      pi,
      { ...ctx, modelRegistry: { ...ctx.modelRegistry, getAvailable: () => [] } },
      id,
    ),
  ).rejects.toThrow("authorized model");
  await expect(
    manager.reopen(
      pi,
      { ...ctx, scopedModels: [{ model: { provider: "test", id: "other" } }] },
      id,
      { scopeModels: true },
    ),
  ).rejects.toThrow("not in scope");
  vi.mocked(runAgent).mockResolvedValueOnce({ session: mockSession(), responseText: "done" });
  const lost = manager.spawn(pi, ctx, "worker", "lost", { description: "lost" });
  await manager.getRecord(lost)!.promise;
  await manager.close(lost);
  await expect(manager.reopen(pi, ctx, lost)).rejects.toThrow("no recoverable conversation");
  // An invalid manager snapshot must fail explicitly rather than load another session.
  vi.mocked(runAgent).mockResolvedValueOnce({
    session: {
      ...mockSession(),
      sessionManager: {
        getHeader: () => ({ type: "session", id: "", cwd: "/tmp" }),
        getBranch: () => [{ type: "message", id: "", parentId: null }],
      },
    },
    responseText: "done",
  });
  const bad = manager.spawn(pi, ctx, "worker", "bad", { description: "bad" });
  await manager.getRecord(bad)!.promise;
  await manager.close(bad);
  await expect(manager.reopen(pi, ctx, bad)).rejects.toThrow("corrupt conversation");
  expect(openAgentSession).not.toHaveBeenCalled();
});

it("cancels before and during reopening, tears down once, and preserves committed agents", async () => {
  const id = await closedAgent();
  const early = new AbortController();
  early.abort();
  await expect(manager.reopen(pi, ctx, id, { signal: early.signal })).rejects.toThrow();
  expect(openAgentSession).not.toHaveBeenCalled();
  const loading = deferred<any>();
  const session = mockSession();
  vi.mocked(openAgentSession).mockReturnValueOnce(loading.promise);
  const caller = new AbortController();
  const opening = manager.reopen(pi, ctx, id, { signal: caller.signal });
  const rejected = expect(opening).rejects.toThrow();
  caller.abort();
  loading.resolve(session);
  await rejected;
  expect(session.dispose).toHaveBeenCalledOnce();
  expect(manager.getRecord(id)).toBeUndefined();
  const committed = new AbortController();
  vi.mocked(openAgentSession).mockResolvedValueOnce(mockSession());
  await manager.reopen(pi, ctx, id, { signal: committed.signal });
  committed.abort();
  expect(manager.getRecord(id)?.session).toBeDefined();
  expect(() => manager.spawn(pi, ctx, "worker", "full", { description: "full" })).toThrow(
    "concurrency",
  );
});

it("uses stable snapshots when ctx getters throw after entry and cancels on shutdown", async () => {
  const id = await closedAgent();
  let stale = false;
  const ephemeral = Object.fromEntries(Object.keys(ctx).map((key) => [key, ctx[key]]));
  for (const key of Object.keys(ctx))
    Object.defineProperty(ephemeral, key, {
      get() {
        if (stale) throw new Error("stale ctx");
        return ctx[key];
      },
    });
  const loading = deferred<any>();
  vi.mocked(openAgentSession).mockReturnValueOnce(loading.promise);
  const opening = manager.reopen(pi, ephemeral as any, id);
  stale = true;
  const rejected = expect(opening).rejects.toThrow();
  const shutdown = manager.shutdown();
  const session = mockSession();
  loading.resolve(session);
  await rejected;
  await shutdown;
  expect(session.dispose).toHaveBeenCalledOnce();
  expect(manager.listAgents()).toEqual([]);
  expect(manager.getClosedRecord(id)).toBeUndefined();
});

it("lets a concurrent caller cancel only its own wait and closes a committing reopen", async () => {
  const id = await closedAgent();
  const loading = deferred<any>();
  vi.mocked(openAgentSession).mockReturnValueOnce(loading.promise);
  const opening = manager.reopen(pi, ctx, id);
  const follower = new AbortController();
  const joining = manager.reopen(pi, ctx, id, { signal: follower.signal });
  const cancelled = expect(joining).rejects.toThrow();
  follower.abort();
  await cancelled;
  const closing = manager.close(id);
  const session = mockSession();
  loading.resolve(session);
  expect(await opening).toBe("pending_init");
  expect(await closing).toBe("pending_init");
  expect(session.dispose).toHaveBeenCalledOnce();
  expect(manager.getRecord(id)).toBeUndefined();
});

it("selected waits observe closing an idle reopen without a synthetic turn", async () => {
  const completion = createAgentCompletionHandler({
    pi,
    getRecord: (id) => manager.getRecord(id),
    onAgentFinishedUI: () => {},
  });
  await manager.dispose();
  manager = new AgentManager(completion.onAgentComplete, 1);
  const id = await closedAgent();
  vi.mocked(openAgentSession).mockResolvedValueOnce(mockSession());
  await manager.reopen(pi, ctx, id);
  expect(manager.getRecord(id)?.status).toBe("idle");
  expect(manager.hasRunning()).toBe(false);
  const waiting = completion.waitFor([id], 10_000);
  expect(await manager.close(id)).toBe("pending_init");
  expect(await waiting).toMatchObject({ timed_out: false, status: { [id]: "shutdown" } });
  expect(resumeAgent).not.toHaveBeenCalled();
  completion.dispose();
});

it.each(["interrupt", "redirect"])(
  "supports %s during the first resumed turn",
  async (operation) => {
    const id = await closedAgent();
    const turn = deferred<string>();
    const session = {
      ...mockSession(),
      abort: vi.fn(async () => {
        turn.resolve("partial");
      }),
    };
    vi.mocked(openAgentSession).mockResolvedValueOnce(session);
    vi.mocked(resumeAgent)
      .mockReturnValueOnce(turn.promise)
      .mockResolvedValueOnce("redirect result");
    await manager.reopen(pi, ctx, id);
    expect(await manager.sendInput(id, "first resumed turn")).toBe(true);
    try {
      const accepted =
        operation === "interrupt"
          ? await manager.interruptTurn(id)
          : await manager.cancelAndSteer(id, "change direction");
      expect(accepted).toBe(true);
      await manager.getRecord(id)!.promise;
      expect(session.abort).toHaveBeenCalledOnce();
      expect(manager.getRecord(id)).toMatchObject(
        operation === "interrupt"
          ? { status: "stopped", abort: { source: "interrupt" } }
          : { status: "completed", result: "redirect result" },
      );
    } finally {
      turn.resolve("cleanup");
      await manager.getRecord(id)!.promise;
    }
  },
);
