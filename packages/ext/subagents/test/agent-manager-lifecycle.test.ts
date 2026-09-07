import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../agent-manager.js";

vi.mock("../agent-runner.js", () => ({
  runAgent: vi.fn(),
  resumeAgent: vi.fn(),
}));

vi.mock("../usage.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../usage.js")>()),
  appendSubagentUsageRecord: vi.fn(() => Promise.resolve()),
}));

vi.mock("../diagnostics.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../diagnostics.js")>()),
  appendSubagentDiagnostic: vi.fn(() => Promise.resolve()),
}));

import { resumeAgent, runAgent } from "../agent-runner.js";
import { appendSubagentDiagnostic } from "../diagnostics.js";
import { mockCtx, mockPendingRun, mockPi, mockSession } from "./helpers/agent-manager-mocks.js";

function staleableParentCtx(): { parent: any; goStale: () => void } {
  let stale = false;
  const assertLive = () => {
    if (stale) throw new Error("stale ctx");
  };
  const parent = {
    get cwd() {
      assertLive();
      return "/tmp";
    },
    get model() {
      assertLive();
      return undefined;
    },
    get modelRegistry() {
      assertLive();
      return mockCtx.modelRegistry;
    },
    getSystemPrompt: () => {
      assertLive();
      return "parent prompt";
    },
    sessionManager: mockCtx.sessionManager,
  } as any;
  return { parent, goStale: () => (stale = true) };
}

describe("AgentManager — detached lifecycle", () => {
  let manager: AgentManager;
  afterEach(() => manager.dispose());

  it("keeps the raw spawn prompt on the agent record", () => {
    manager = new AgentManager();
    mockPendingRun();

    const id = manager.spawn(mockPi, mockCtx, "worker", "raw task", {
      description: "task",
    });

    expect(manager.getRecord(id)?.prompt).toBe("raw task");
  });

  it("rejects unsupported roles instead of falling back to a write-capable default agent", () => {
    manager = new AgentManager();

    for (const role of ["legacy-role", " "]) {
      expect(() => manager.spawn(mockPi, mockCtx, role, "task", { description: "task" })).toThrow(
        `Unknown agent type '${role}'.`,
      );
    }
    expect(manager.listAgents()).toEqual([]);
  });

  it("snapshots a queued agent's stable dependencies before the extension context goes stale", async () => {
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

    const { parent, goStale } = staleableParentCtx();

    const first = manager.spawn(mockPi, parent, "worker", "first", {
      description: "first",
    });
    const second = manager.spawn(mockPi, parent, "worker", "second", {
      description: "second",
    });
    goStale();
    resolveFirst({ responseText: "first", session: mockSession() });

    await manager.getRecord(first)!.promise;
    await vi.waitFor(() => expect(manager.getRecord(second)?.status).toBe("completed"));
    expect(vi.mocked(runAgent).mock.calls[1]?.[0]).toMatchObject({
      cwd: "/tmp",
      sessionId: "parent-session",
      systemPrompt: "parent prompt",
    });
  });

  it("snapshots full-history fork entries before a queued parent context goes stale", async () => {
    manager = new AgentManager(undefined, 1);
    vi.mocked(runAgent).mockClear();
    mockPendingRun();
    const entries = [{ type: "message", id: "m1", parentId: null, message: { role: "user" } }];
    let stale = false;
    const parent = {
      ...mockCtx,
      sessionManager: {
        getSessionId: () => "parent-session",
        buildContextEntries: () => {
          if (stale) throw new Error("stale ctx");
          return entries;
        },
      },
    } as any;

    manager.spawn(mockPi, parent, "worker", "blocker", { description: "blocker" });
    manager.spawn(mockPi, parent, "default", "forked", {
      description: "forked",
      forkContext: true,
    });
    entries[0]!.message.role = "assistant";
    stale = true;

    expect(vi.mocked(runAgent).mock.calls[1]?.[3].parentEntries).toBeUndefined();
    manager.setMaxConcurrent(2);
    await vi.waitFor(() => expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(2));
    expect(vi.mocked(runAgent).mock.calls[1]?.[3].parentEntries).toEqual([
      expect.objectContaining({ message: { role: "user" } }),
    ]);
  });

  it("starts a second turn on a retained session without reading stale extension context", async () => {
    const completedGenerations: number[] = [];
    manager = new AgentManager((_record, generation) => completedGenerations.push(generation));
    const session = mockSession();
    const onTurnEnd = vi.fn();
    const onTextDelta = vi.fn();
    vi.mocked(runAgent).mockImplementation(async (_parent, _type, _prompt, options) => {
      options.onTurnEnd?.(1);
      options.onAssistantUsage?.({ input: 10, output: 2, cacheWrite: 1 });
      options.onCompaction?.({ reason: "threshold", tokensBefore: 1_000 });
      return { responseText: "first result", session };
    });
    vi.mocked(resumeAgent).mockImplementation(async (_session, _prompt, options) => {
      options?.onTurnEnd?.(2);
      options?.onTextDelta?.("second", "second");
      options?.onAssistantUsage?.({ input: 20, output: 3, cacheWrite: 2 });
      options?.onCompaction?.({ reason: "manual", tokensBefore: 2_000 });
      return "second result";
    });

    const { parent, goStale } = staleableParentCtx();

    const id = manager.spawn(mockPi, parent, "worker", "first", {
      description: "two turns",
      onTurnEnd,
      onTextDelta,
    });
    await manager.getRecord(id)!.promise;
    const firstCompletion = vi
      .mocked(appendSubagentDiagnostic)
      .mock.calls.map(([entry]) => entry)
      .reverse()
      .find((entry) => entry.event === "completed" && entry.details?.generation === 1);
    goStale();

    expect(manager.startTurn(id, "second")).toBe(true);
    await manager.getRecord(id)!.promise;

    expect(resumeAgent).toHaveBeenCalledWith(
      session,
      "second",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(manager.getRecord(id)).toMatchObject({
      generation: 2,
      prompt: "second",
      result: "second result",
      status: "completed",
      lifetimeUsage: { input: 30, output: 5, cacheWrite: 3 },
      compactionCount: 2,
    });
    expect(completedGenerations).toEqual([1, 2]);
    expect(onTurnEnd).toHaveBeenCalledWith(2);
    expect(onTextDelta).toHaveBeenCalledWith("second", "second");
    expect(firstCompletion?.details?.lifetime_usage).toEqual({
      input: 10,
      output: 2,
      cacheWrite: 1,
    });
    expect((manager as any).runningCount).toBe(0);
  });

  it("queues a retained session's next turn until it can reacquire a slot", async () => {
    manager = new AgentManager(undefined, 1);
    vi.mocked(resumeAgent).mockClear();
    const retainedSession = mockSession();
    vi.mocked(runAgent).mockResolvedValueOnce({
      responseText: "first result",
      session: retainedSession,
    });

    const retained = manager.spawn(mockPi, mockCtx, "worker", "first", {
      description: "retained",
    });
    await manager.getRecord(retained)!.promise;

    let finishBlocker!: (value: { responseText: string; session: any }) => void;
    vi.mocked(runAgent).mockImplementationOnce(
      () => new Promise((resolve) => (finishBlocker = resolve)),
    );
    const blocker = manager.spawn(mockPi, mockCtx, "worker", "block", {
      description: "blocker",
    });
    vi.mocked(resumeAgent).mockResolvedValue("second result");

    expect(manager.startTurn(retained, "second")).toBe(true);
    expect(manager.steer(retained, "queued guidance")).toBe(true);
    expect(manager.getRecord(retained)).toMatchObject({ generation: 2, status: "queued" });
    expect(resumeAgent).not.toHaveBeenCalled();

    finishBlocker({ responseText: "block done", session: mockSession() });
    await manager.getRecord(blocker)!.promise;
    await vi.waitFor(() => expect(manager.getRecord(retained)?.status).toBe("completed"));

    expect(resumeAgent).toHaveBeenCalledWith(
      retainedSession,
      "second",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(retainedSession.steer).toHaveBeenCalledWith("queued guidance");
    expect(retainedSession.steer.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(resumeAgent).mock.invocationCallOrder[0]!,
    );
    expect((manager as any).runningCount).toBe(0);
  });

  it("interrupts only the current turn and leaves its retained session reusable", async () => {
    manager = new AgentManager();
    const session = { ...mockSession(), abort: vi.fn() };
    vi.mocked(runAgent).mockResolvedValue({ responseText: "first result", session });
    const id = manager.spawn(mockPi, mockCtx, "worker", "first", {
      description: "interruptible",
    });
    await manager.getRecord(id)!.promise;

    let finishInterrupted!: (result: string) => void;
    vi.mocked(resumeAgent)
      .mockImplementationOnce(() => new Promise((resolve) => (finishInterrupted = resolve)))
      .mockResolvedValueOnce("third result");
    session.abort.mockImplementation(async () => finishInterrupted("partial result"));
    expect(manager.startTurn(id, "second")).toBe(true);

    await expect(manager.interruptTurn(id)).resolves.toBe(true);

    expect(session.abort).toHaveBeenCalledOnce();
    expect(session.clearQueue).toHaveBeenCalledTimes(2);
    expect(manager.getRecord(id)).toMatchObject({
      generation: 2,
      status: "stopped",
      result: "partial result",
      error: "interrupted",
      abort: { source: "interrupt" },
      session,
    });
    expect((manager as any).runningCount).toBe(0);

    expect(manager.startTurn(id, "third")).toBe(true);
    await manager.getRecord(id)!.promise;
    expect(manager.getRecord(id)).toMatchObject({
      generation: 3,
      status: "completed",
      result: "third result",
      error: undefined,
    });
  });

  it("restores a running turn when non-destructive interruption fails", async () => {
    manager = new AgentManager();
    const session = {
      ...mockSession(),
      abort: vi.fn(async () => Promise.reject(new Error("busy"))),
    };
    session.clearQueue.mockReturnValue({ steering: ["steer me"], followUp: ["later"] });
    vi.mocked(runAgent).mockResolvedValue({ responseText: "first", session });
    let finishTurn!: (result: string) => void;
    vi.mocked(resumeAgent).mockImplementationOnce(
      () => new Promise((resolve) => (finishTurn = resolve)),
    );
    const id = manager.spawn(mockPi, mockCtx, "worker", "first", {
      description: "interruptible",
    });
    await manager.getRecord(id)!.promise;
    expect(manager.startTurn(id, "second")).toBe(true);

    await expect(manager.interruptTurn(id)).resolves.toBe(false);
    expect(manager.getRecord(id)).toMatchObject({ status: "running", error: undefined });
    expect(session.steer).toHaveBeenCalledWith("steer me");
    expect(session.followUp).toHaveBeenCalledWith("later");
    expect((manager as any).runningCount).toBe(1);

    finishTurn("finished normally");
    await manager.getRecord(id)!.promise;
    expect(manager.getRecord(id)).toMatchObject({
      status: "completed",
      result: "finished normally",
    });
  });

  it("applies cancel-and-steer during a retained turn", async () => {
    manager = new AgentManager();
    const session = { ...mockSession(), abort: vi.fn(async () => {}) };
    vi.mocked(runAgent).mockResolvedValue({ responseText: "first", session });
    let finishRetained!: () => void;
    let finishRedirect!: () => void;
    vi.mocked(resumeAgent)
      .mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => (finishRetained = resolve));
        return "partial";
      })
      .mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => (finishRedirect = resolve));
        return "first redirect";
      })
      .mockResolvedValueOnce("redirected");

    const id = manager.spawn(mockPi, mockCtx, "worker", "first", {
      description: "retained",
    });
    await manager.getRecord(id)!.promise;
    expect(manager.startTurn(id, "continue")).toBe(true);
    expect(manager.cancelAndSteer(id, "change course")).toBe(true);
    finishRetained();
    await vi.waitFor(() =>
      expect(vi.mocked(resumeAgent).mock.calls.at(-1)?.[1]).toBe("change course"),
    );
    expect(manager.cancelAndSteer(id, "change again")).toBe(true);
    finishRedirect();
    await manager.getRecord(id)!.promise;

    expect(
      vi
        .mocked(resumeAgent)
        .mock.calls.slice(-3)
        .map((call) => call[1]),
    ).toEqual(["continue", "change course", "change again"]);
    expect(manager.getRecord(id)).toMatchObject({ status: "completed", result: "redirected" });
  });

  it("retains every accepted redirect when interrupts arrive before cancellation settles", async () => {
    manager = new AgentManager();
    const session = { ...mockSession(), abort: vi.fn(async () => {}) };
    let finishInitial!: () => void;
    vi.mocked(runAgent).mockImplementation(async (_parent, _type, _prompt, options) => {
      options.onSessionCreated?.(session);
      await new Promise<void>((resolve) => (finishInitial = resolve));
      return { responseText: "partial", session };
    });
    vi.mocked(resumeAgent)
      .mockResolvedValueOnce("first redirect")
      .mockResolvedValueOnce("second redirect");

    const id = manager.spawn(mockPi, mockCtx, "worker", "first", {
      description: "retained",
    });
    expect(manager.cancelAndSteer(id, "change once")).toBe(true);
    expect(manager.cancelAndSteer(id, "change twice")).toBe(true);
    finishInitial();
    await manager.getRecord(id)!.promise;

    expect(
      vi
        .mocked(resumeAgent)
        .mock.calls.slice(-2)
        .map((call) => call[1]),
    ).toEqual(["change once", "change twice"]);
    expect(manager.getRecord(id)).toMatchObject({
      status: "completed",
      result: "second redirect",
    });
  });

  it("drops steering owned by a cancelled queued generation", async () => {
    manager = new AgentManager(undefined, 1);
    const session = { ...mockSession(), steer: vi.fn(async () => {}), clearQueue: vi.fn() };
    let finishBlocker!: (value: { responseText: string; session: any }) => void;
    vi.mocked(runAgent)
      .mockResolvedValueOnce({ responseText: "first", session })
      .mockImplementationOnce(() => new Promise((resolve) => (finishBlocker = resolve)));
    vi.mocked(resumeAgent).mockResolvedValue("fresh");

    const retained = manager.spawn(mockPi, mockCtx, "worker", "first", {
      description: "retained",
    });
    await manager.getRecord(retained)!.promise;
    const blocker = manager.spawn(mockPi, mockCtx, "worker", "block", {
      description: "blocker",
    });
    expect(manager.startTurn(retained, "cancel me")).toBe(true);
    expect(manager.steer(retained, "stale steer")).toBe(true);
    expect(manager.abort(retained)).toBe(true);

    finishBlocker({ responseText: "done", session: mockSession() });
    await manager.getRecord(blocker)!.promise;
    expect(manager.startTurn(retained, "fresh turn")).toBe(true);
    await manager.getRecord(retained)!.promise;

    expect(session.steer).not.toHaveBeenCalledWith("stale steer");
    expect(resumeAgent).toHaveBeenLastCalledWith(session, "fresh turn", expect.any(Object));
  });

  it("publishes a generation before queue-drain reentrancy can mutate it", async () => {
    const completed: Array<{ id: string; generation: number; result?: string }> = [];
    let retainedId = "";
    manager = new AgentManager(
      (record, generation) => completed.push({ id: record.id, generation, result: record.result }),
      1,
      (started) => {
        if (started.description === "blocker" && retainedId) {
          expect(manager.startTurn(retainedId, "reentrant")).toBe(true);
        }
      },
    );
    let finishFirst!: (value: { responseText: string; session: any }) => void;
    const retainedSession = mockSession();
    vi.mocked(runAgent)
      .mockImplementationOnce(() => new Promise((resolve) => (finishFirst = resolve)))
      .mockResolvedValueOnce({ responseText: "blocker done", session: mockSession() });
    vi.mocked(resumeAgent).mockResolvedValue("reentrant done");

    retainedId = manager.spawn(mockPi, mockCtx, "worker", "first", {
      description: "retained",
    });
    manager.spawn(mockPi, mockCtx, "worker", "block", { description: "blocker" });
    finishFirst({ responseText: "first result", session: retainedSession });
    await manager.waitForAll();

    expect(completed[0]).toEqual({ id: retainedId, generation: 1, result: "first result" });
  });

  it("tracks a turn before start-callback reentrancy can wait for it", async () => {
    let waitFromStart!: Promise<void>;
    let waitSettled = false;
    manager = new AgentManager(undefined, 1, () => {
      waitFromStart = manager.waitForAll().then(() => {
        waitSettled = true;
      });
    });
    let finish!: (value: { responseText: string; session: any }) => void;
    vi.mocked(runAgent).mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));

    manager.spawn(mockPi, mockCtx, "worker", "first", { description: "tracked" });
    await Promise.resolve();
    expect(waitSettled).toBe(false);

    finish({ responseText: "done", session: mockSession() });
    await waitFromStart;
    expect(waitSettled).toBe(true);
  });

  it("does not drain queued work when completion reentrantly starts shutdown", async () => {
    let shutdown!: Promise<void>;
    const priorRuns = vi.mocked(runAgent).mock.calls.length;
    manager = new AgentManager((record) => {
      if (record.description === "first") shutdown = manager.shutdown();
    }, 1);
    let finish!: (value: { responseText: string; session: any }) => void;
    vi.mocked(runAgent).mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    const first = manager.spawn(mockPi, mockCtx, "worker", "first", {
      description: "first",
    });
    const queued = manager.spawn(mockPi, mockCtx, "worker", "queued", {
      description: "queued",
    });

    finish({ responseText: "done", session: mockSession() });
    await manager.getRecord(first)!.promise;
    await shutdown;

    expect(runAgent).toHaveBeenCalledTimes(priorRuns + 1);
    expect(manager.getRecord(queued)).toBeUndefined();
  });

  it("emits created with a stable identity for every spawn", () => {
    const pi = { events: { emit: vi.fn() } } as any;
    manager = new AgentManager();
    mockPendingRun();

    const id = manager.spawn(pi, mockCtx, "worker", "task", { description: "task" });

    expect(pi.events.emit).toHaveBeenCalledWith("subagents:created", {
      id,
      generation: 1,
      type: "worker",
      description: "task",
    });
  });

  it("cancels a child that finishes initializing during shutdown", async () => {
    manager = new AgentManager();
    let finishInitializing!: () => void;
    const initializing = new Promise<void>((resolve) => (finishInitializing = resolve));
    const session = mockSession();
    let cleanupStarted!: () => void;
    const cleaning = new Promise<void>((resolve) => (cleanupStarted = resolve));
    let finishCleanup!: () => void;
    const cleanupFinished = new Promise<void>((resolve) => (finishCleanup = resolve));
    session.extensionRunner.emit.mockImplementation(async () => {
      cleanupStarted();
      await cleanupFinished;
    });
    const providerStarted = vi.fn();
    let reenteredShutdown: Promise<void> | undefined;
    vi.mocked(runAgent).mockImplementation(async (_parent, _type, _prompt, options) => {
      options.signal?.addEventListener("abort", () => (reenteredShutdown = manager.dispose()), {
        once: true,
      });
      await initializing;
      options.onSessionCreated?.(session);
      if (!options.signal?.aborted) providerStarted();
      if (options.signal?.aborted) throw new Error("cancelled");
      return { responseText: "late", session };
    });

    manager.spawn(mockPi, mockCtx, "worker", "task", { description: "task" });
    const shutdown = manager.shutdown();
    finishInitializing();
    await cleaning;
    let shutdownReturned = false;
    void shutdown.then(() => {
      shutdownReturned = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    const returnedBeforeCleanup = shutdownReturned;
    finishCleanup();
    await shutdown;

    expect(reenteredShutdown).toBe(shutdown);
    expect(returnedBeforeCleanup).toBe(false);
    expect(providerStarted).not.toHaveBeenCalled();
    expect(session.extensionRunner.emit).toHaveBeenCalledWith({
      type: "session_shutdown",
      reason: "quit",
    });
    expect(session.dispose).toHaveBeenCalledOnce();
  });

  it("rejects spawns after shutdown begins", async () => {
    manager = new AgentManager();

    const shutdown = manager.shutdown();
    expect(manager.shutdown()).toBe(shutdown);
    expect(manager.dispose()).toBe(shutdown);

    expect(() =>
      manager.spawn(mockPi, mockCtx, "worker", "too late", {
        description: "too late",
      }),
    ).toThrow(/shutting down/i);
    await shutdown;
  });

  it("treats a whitespace-only terminal response as an error", async () => {
    const onComplete = vi.fn();
    manager = new AgentManager(onComplete);
    vi.mocked(runAgent).mockResolvedValue({ responseText: " \n\t", session: mockSession() });

    const id = manager.spawn(mockPi, mockCtx, "worker", "task", {
      description: "task",
    });
    await manager.getRecord(id)?.promise;

    expect(manager.getRecord(id)).toMatchObject({
      status: "error",
      error: "Agent completed without a final response.",
    });
    expect(manager.getRecord(id)?.result).toBeUndefined();
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it("fixes child messages to the spawning parent and sender identity", () => {
    const messageParent = vi.fn(() => true);
    manager = new AgentManager(undefined, 4, undefined, undefined, messageParent);
    mockPendingRun();

    const id = manager.spawn(mockPi, mockCtx, "explorer", "task", {
      description: "trace auth flow",
      invocation: { modelName: "openai/gpt-5", thinking: "high" },
    });
    const transport = vi.mocked(runAgent).mock.calls.at(-1)?.[3].messageParent;

    expect(transport?.("found it")).toBe(true);
    expect(messageParent).toHaveBeenCalledWith(
      "parent-session",
      {
        id,
        type: "explorer",
        title: "trace auth flow",
        model_name: "openai/gpt-5",
        thinking: "high",
      },
      "found it",
    );
  });
});
