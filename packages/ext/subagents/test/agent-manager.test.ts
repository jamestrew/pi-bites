/* oxlint-disable max-lines */
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentManager, MAX_RETAINED_TOOL_CALLS } from "../agent-manager.js";

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

const mockSession = () =>
  ({
    abort: vi.fn(async () => {}),
    clearQueue: vi.fn(() => ({ steering: [], followUp: [] })),
    dispose: vi.fn(),
    extensionRunner: { emit: vi.fn(async () => {}) },
    followUp: vi.fn(async () => {}),
    steer: vi.fn(async () => {}),
  }) as any;

const resolvedRun = () =>
  vi.mocked(runAgent).mockResolvedValue({
    responseText: "done",
    session: mockSession(),
  });

function waitForCancellation(signal?: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    const cancel = () => reject(new Error("cancelled"));
    if (signal?.aborted) cancel();
    else signal?.addEventListener("abort", cancel, { once: true });
  });
}

function mockPendingRun(): void {
  vi.mocked(runAgent).mockImplementation((_parent, _type, _prompt, options) =>
    waitForCancellation(options.signal),
  );
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

    const first = manager.spawn(mockPi, parent, "worker", "first", {
      description: "first",
    });
    const second = manager.spawn(mockPi, parent, "worker", "second", {
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
    stale = true;

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

describe("AgentManager — completion callbacks", () => {
  let manager: AgentManager;

  afterEach(() => manager.dispose());

  it("retains a quota failure when a later abort becomes the terminal error", async () => {
    manager = new AgentManager();
    vi.mocked(runAgent).mockImplementation(async (_parent, _type, _prompt, options) => {
      options.onAssistantFailure?.({
        timestamp: 10,
        phase: "assistant",
        message: "429 quota exceeded",
        stop_reason: "error",
        manager_signal_aborted: false,
      });
      options.onAssistantFailure?.({
        timestamp: 20,
        phase: "assistant",
        message: "The operation was aborted.",
        stop_reason: "error",
        manager_signal_aborted: false,
      });
      throw new Error("The operation was aborted.");
    });

    const id = manager.spawn(mockPi, mockCtx, "worker", "test", {
      description: "test",
    });
    await manager.getRecord(id)!.promise;

    expect(manager.getRecord(id)).toMatchObject({
      status: "error",
      error: "The operation was aborted.",
      failureHistory: [
        { phase: "assistant", message: "429 quota exceeded" },
        { phase: "assistant", message: "The operation was aborted." },
        { phase: "manager", message: "The operation was aborted." },
      ],
    });
  });

  it("does not let onComplete errors turn a completed agent into a failed run", async () => {
    manager = new AgentManager(() => {
      throw new Error("stale extension context");
    });
    resolvedRun();

    const id = manager.spawn(mockPi, mockCtx, "worker", "test", {
      description: "test",
    });
    await expect(manager.getRecord(id)!.promise).resolves.toBe("done");

    expect(manager.getRecord(id)!.status).toBe("completed");
  });
});

describe("AgentManager — cleanup timer", () => {
  let manager: AgentManager;

  afterEach(() => manager.dispose());

  it("does not keep the process alive on its own", () => {
    manager = new AgentManager();

    expect((manager as any).cleanupInterval.hasRef()).toBe(false);
  });
});

describe("AgentManager — Bug 3 clearCompleted", () => {
  let manager: AgentManager;

  afterEach(() => manager.dispose());

  it("clearCompleted removes completed records", async () => {
    manager = new AgentManager();
    resolvedRun();

    const id = manager.spawn(mockPi, mockCtx, "worker", "test", {
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
    mockPendingRun();

    const id1 = manager.spawn(mockPi, mockCtx, "worker", "test1", {
      description: "running agent",
    });
    // Second agent should be queued (limit=1)
    const id2 = manager.spawn(mockPi, mockCtx, "worker", "test2", {
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
    const sess = { dispose: disposeSpy, extensionRunner: { emit: vi.fn(async () => {}) } };
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "done",
      session: sess as any,
    });

    const id = manager.spawn(mockPi, mockCtx, "worker", "test", {
      description: "test",
    });
    await manager.getRecord(id)!.promise;

    manager.clearCompleted();
    await new Promise((resolve) => setImmediate(resolve));

    expect(disposeSpy).toHaveBeenCalledOnce();
  });

  it("clearCompleted removes error and stopped records", async () => {
    manager = new AgentManager();
    vi.mocked(runAgent).mockRejectedValue(new Error("boom"));

    const id = manager.spawn(mockPi, mockCtx, "worker", "test", {
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

  afterEach(() => manager.dispose());

  it("spawn initializes lifetimeUsage to zeros and compactionCount to 0", () => {
    manager = new AgentManager();
    // Don't resolve the run — we just want to inspect the record at spawn time.
    mockPendingRun();

    const id = manager.spawn(mockPi, mockCtx, "worker", "test", {
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

    const id = manager.spawn(mockPi, mockCtx, "worker", "test", {
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

    const id = manager.spawn(mockPi, mockCtx, "worker", "test", {
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

    const id = manager.spawn(mockPi, mockCtx, "worker", "test", {
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
    expect(resumeMock).toHaveBeenLastCalledWith(
      session,
      "change course",
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        onTurnEnd: expect.any(Function),
        onTextDelta: expect.any(Function),
      }),
    );
  });
});

describe("AgentManager — SpawnOptions.cwd passthrough (#96)", () => {
  let manager: AgentManager;
  afterEach(() => manager.dispose());

  it("runs in the caller-supplied shared directory and keeps parent config", async () => {
    resolvedRun();
    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "worker", "test", {
      description: "test",
      cwd: "/", // absolute and always exists
    });
    await manager.getRecord(id)!.promise;

    expect(runAgent).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/tmp", sessionId: "parent-session" }),
      "worker",
      "test",
      expect.objectContaining({ cwd: "/", configCwd: "/tmp" }),
    );
  });

  it("shares the parent session's working directory when cwd is omitted", async () => {
    // mockClear + lastCall: toHaveBeenCalledWith would scan the file's whole
    // accumulated call history, where earlier no-cwd spawns already match.
    vi.mocked(runAgent).mockClear();
    resolvedRun();
    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "worker", "test", {
      description: "test",
    });
    await manager.getRecord(id)!.promise;

    const opts = vi.mocked(runAgent).mock.lastCall![3];
    expect(vi.mocked(runAgent).mock.lastCall![0]).toMatchObject({ cwd: "/tmp" });
    expect(opts.cwd).toBeUndefined();
    expect(opts.configCwd).toBeUndefined();
  });

  it("cwd: null (RPC 'unset') behaves exactly like omitting cwd", async () => {
    vi.mocked(runAgent).mockClear();
    resolvedRun();
    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "worker", "test", {
      description: "test",
      cwd: null as any,
    });
    await manager.getRecord(id)!.promise;

    const opts = vi.mocked(runAgent).mock.lastCall![3];
    expect(opts.cwd).toBeUndefined();
    expect(opts.configCwd).toBeUndefined();
  });

  it("relative cwd throws immediately; no orphan record", () => {
    vi.mocked(runAgent).mockClear();
    manager = new AgentManager();
    expect(() =>
      manager.spawn(mockPi, mockCtx, "worker", "test", {
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
      manager.spawn(mockPi, mockCtx, "worker", "test", {
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
      manager.spawn(mockPi, mockCtx, "worker", "test", {
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
      manager.spawn(mockPi, mockCtx, "worker", "test", {
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
    mockPendingRun();

    manager.spawn(mockPi, mockCtx, "worker", "blocker", { description: "block" });
    const queuedId = manager.spawn(mockPi, mockCtx, "worker", "queued", {
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
      return waitForCancellation(opts.signal);
    });

    const id = manager.spawn(mockPi, mockCtx, "worker", "p", {
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
    const id = manager.spawn(mockPi, mockCtx, "worker", "p", {
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
    manager = new AgentManager(onComplete, 1);
    let resolveRun!: (v: unknown) => void;
    vi.mocked(runAgent)
      .mockImplementationOnce(
        () =>
          new Promise((res) => {
            resolveRun = res as (v: unknown) => void;
          }),
      )
      .mockResolvedValueOnce({ responseText: "queued result", session: mockSession() });

    const id = manager.spawn(mockPi, mockCtx, "worker", "p", { description: "r" });
    const record = manager.getRecord(id)!;
    const queuedId = manager.spawn(mockPi, mockCtx, "worker", "q", { description: "queued" });
    expect(record.status).toBe("running");
    expect(manager.getRecord(queuedId)?.status).toBe("queued");

    expect(manager.abort(id)).toBe(true);
    expect(record.status).toBe("stopped");
    expect(onComplete).not.toHaveBeenCalled();
    expect((manager as any).runningCount).toBe(1);
    expect(manager.getRecord(queuedId)?.status).toBe("queued");

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
    expect(onComplete.mock.calls.filter(([completed]) => completed === record)).toHaveLength(1);
    expect(manager.getRecord(queuedId)?.status).not.toBe("queued");
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
      return waitForCancellation(opts.signal);
    });
    const id = manager.spawn(mockPi, mockCtx, "worker", "p", { description: "r" });
    // Simulate the session becoming ready.
    captured?.({ steer, dispose: vi.fn(), isStreaming: true });

    expect(manager.steer(id, "go left")).toBe(true);
    expect(steer).toHaveBeenCalledWith("go left");
  });

  it("queues onto pendingSteers when the session isn't ready yet", () => {
    manager = new AgentManager();
    mockPendingRun();
    const id = manager.spawn(mockPi, mockCtx, "worker", "p", { description: "r" });
    const record = manager.getRecord(id)!;
    record.session = undefined; // not ready

    expect(manager.steer(id, "first")).toBe(true);
    expect(manager.steer(id, "second")).toBe(true);
    expect(record.pendingSteers).toEqual(["first", "second"]);
  });

  it("rejects a message to a completed session", async () => {
    manager = new AgentManager();
    resolvedRun();
    const id = manager.spawn(mockPi, mockCtx, "worker", "p", { description: "x" });
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

    const a = manager.spawn(mockPi, mockCtx, "worker", "1", { description: "a" });
    const b = manager.spawn(mockPi, mockCtx, "worker", "2", { description: "b" });
    const c = manager.spawn(mockPi, mockCtx, "worker", "3", { description: "c" });

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
    mockPendingRun();

    const running = manager.spawn(mockPi, mockCtx, "worker", "r", {
      description: "r",
    });
    const queued = manager.spawn(mockPi, mockCtx, "worker", "q", {
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
    const id = manager.spawn(mockPi, mockCtx, "worker", "p", {
      description: "x",
    });
    expect(manager.hasRunning()).toBe(true);

    await manager.getRecord(id)?.promise;
    expect(manager.hasRunning()).toBe(false);
  });

  it("is true when an agent is queued behind the concurrency limit", () => {
    manager = new AgentManager(undefined, 1);
    mockPendingRun();

    manager.spawn(mockPi, mockCtx, "worker", "r", { description: "r" });
    manager.spawn(mockPi, mockCtx, "worker", "q", { description: "q" });
    expect(manager.hasRunning()).toBe(true);
  });
});

describe("AgentManager — runAgent rejection leaves the record visible with error status", () => {
  let manager: AgentManager;
  afterEach(() => manager.dispose());

  it("sets status='error', captures the error message, and stamps completedAt", async () => {
    manager = new AgentManager();
    vi.mocked(runAgent).mockRejectedValue(new Error("boom"));

    const id = manager.spawn(mockPi, mockCtx, "worker", "p", {
      description: "x",
    });
    const record = manager.getRecord(id)!;
    await record.promise;

    expect(record.status).toBe("error");
    expect(record.error).toBe("boom");
    expect(record.completedAt).toBeGreaterThan(0);
  });
});
