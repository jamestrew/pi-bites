import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

import { runAgent } from "../agent-runner.js";
import { mockCtx, mockPi, mockSession } from "./helpers/agent-manager-mocks.js";

describe("AgentManager.close", () => {
  let manager: AgentManager;

  beforeEach(() => vi.clearAllMocks());

  afterEach(async () => {
    await manager.dispose();
  });

  it("releases a completed agent's retained slot when it is closed", async () => {
    manager = new AgentManager(undefined, 1);
    const completedSession = mockSession();
    vi.mocked(runAgent)
      .mockResolvedValueOnce({ responseText: "finished", session: completedSession })
      .mockResolvedValueOnce({ responseText: "next", session: mockSession() });

    const completed = manager.spawn(mockPi, mockCtx, "worker", "first", {
      description: "first",
    });
    await manager.getRecord(completed)!.promise;
    const queued = manager.spawn(mockPi, mockCtx, "worker", "second", {
      description: "second",
    });

    expect(manager.getRecord(queued)?.status).toBe("queued");
    const closing = manager.close(completed);
    await expect(manager.sendInput(completed, "too late")).resolves.toBe(false);
    await expect(closing).resolves.toEqual({ completed: "finished" });
    await vi.waitFor(() => expect(manager.getRecord(queued)?.status).toBe("completed"));

    expect(manager.getRecord(completed)).toBeUndefined();
    expect(manager.getClosedRecord(completed)).toEqual({ id: completed, recoverable: false });
    expect(completedSession.extensionRunner.emit).toHaveBeenCalledOnce();
    expect(completedSession.dispose).toHaveBeenCalledOnce();
  });

  it("retains only manager-owned reopen metadata for a persisted session", async () => {
    manager = new AgentManager();
    const session = { ...mockSession(), sessionFile: "/sessions/agent.jsonl" };
    vi.mocked(runAgent).mockResolvedValueOnce({ responseText: "finished", session });
    const id = manager.spawn(mockPi, mockCtx, "explorer", "inspect", {
      description: "inspect",
    });
    await manager.getRecord(id)!.promise;

    await manager.close(id);

    expect(manager.getClosedRecord(id)).toEqual({
      id,
      recoverable: true,
      sessionFile: "/sessions/agent.jsonl",
      type: "explorer",
      parentSessionId: "parent-session",
      description: "inspect",
    });
  });

  it("captures a persisted session that finishes initializing during close", async () => {
    manager = new AgentManager();
    const session = { ...mockSession(), sessionFile: "/sessions/late-agent.jsonl" };
    vi.mocked(runAgent).mockImplementationOnce(
      (_parent, _type, _prompt, options) =>
        new Promise((_resolve, reject) => {
          options.signal?.addEventListener(
            "abort",
            () => {
              options.onSessionCreated?.(session);
              reject(new Error("aborted"));
            },
            { once: true },
          );
        }),
    );
    const id = manager.spawn(mockPi, mockCtx, "explorer", "inspect", {
      description: "late inspect",
    });

    await manager.close(id);

    expect(manager.getClosedRecord(id)).toEqual({
      id,
      recoverable: true,
      sessionFile: "/sessions/late-agent.jsonl",
      type: "explorer",
      parentSessionId: "parent-session",
      description: "late inspect",
    });
    expect(session.dispose).toHaveBeenCalledOnce();
  });

  it("closes a running agent once and reports its pre-shutdown status", async () => {
    const completed = vi.fn();
    manager = new AgentManager(completed, 1);
    const session = mockSession();
    const followerSession = mockSession();
    vi.mocked(runAgent)
      .mockImplementationOnce(async (_parent, _type, _prompt, options) => {
        options.onSessionCreated?.(session);
        await new Promise<void>((_resolve, reject) => {
          options.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        });
        return { responseText: "unreachable", session };
      })
      .mockImplementationOnce(async (_parent, _type, _prompt, options) => {
        options.onSessionCreated?.(followerSession);
        await new Promise<void>((_resolve, reject) => {
          options.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        });
        return { responseText: "unreachable", session: followerSession };
      });

    const id = manager.spawn(mockPi, mockCtx, "worker", "running", {
      description: "running",
    });
    const follower = manager.spawn(mockPi, mockCtx, "worker", "follower", {
      description: "follower",
    });
    const first = manager.close(id);
    const repeated = manager.close(id);

    await expect(manager.sendInput(id, "too late")).resolves.toBe(false);
    await expect(manager.cancelAndSteer(id, "too late")).resolves.toBe(false);
    expect(session.steer).not.toHaveBeenCalled();
    await expect(first).resolves.toBe("running");
    await expect(repeated).resolves.toBe("shutdown");
    expect(completed).toHaveBeenCalledOnce();
    expect(session.extensionRunner.emit).toHaveBeenCalledOnce();
    expect(session.dispose).toHaveBeenCalledOnce();
    expect(session.dispose.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(runAgent).mock.invocationCallOrder[1]!,
    );
    expect(manager.getRecord(follower)?.status).toBe("running");
    const queued = manager.spawn(mockPi, mockCtx, "worker", "queued", {
      description: "queued",
    });
    expect(manager.getClosedRecord(id)).toEqual({ id, recoverable: false });
    await expect(manager.close(id)).resolves.toBe("shutdown");
    expect(manager.getRecord(queued)?.status).toBe("queued");
  });

  it("releases once when completion races with the close request", async () => {
    manager = new AgentManager(undefined, 1);
    const session = mockSession();
    vi.mocked(runAgent)
      .mockResolvedValueOnce({ responseText: "done", session })
      .mockResolvedValueOnce({ responseText: "follower", session: mockSession() });

    const id = manager.spawn(mockPi, mockCtx, "worker", "racing", {
      description: "racing",
    });
    await expect(manager.close(id)).resolves.toBe("running");
    const follower = manager.spawn(mockPi, mockCtx, "worker", "follower", {
      description: "follower",
    });
    await manager.getRecord(follower)!.promise;

    expect(manager.getRecord(follower)?.status).toBe("completed");
    expect((manager as any).runningCount).toBe(0);
  });

  it("closes queued agents without consuming or releasing a slot", async () => {
    const completed = vi.fn();
    manager = new AgentManager(completed, 1);
    vi.mocked(runAgent).mockImplementation(async (_parent, _type, _prompt, options) => {
      await new Promise<void>((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
      });
      return { responseText: "unreachable", session: mockSession() };
    });

    const blocker = manager.spawn(mockPi, mockCtx, "worker", "blocker", {
      description: "blocker",
    });
    const queued = manager.spawn(mockPi, mockCtx, "worker", "queued", {
      description: "queued",
    });

    const closing = manager.close(queued);
    expect(manager.steer(queued, "too late")).toBe(false);
    await expect(manager.sendInput(queued, "too late")).resolves.toBe(false);
    await expect(closing).resolves.toBe("pending_init");
    expect(manager.getRecord(blocker)?.status).toBe("running");
    expect(manager.getRecord(queued)).toBeUndefined();
    expect(completed).toHaveBeenCalledOnce();
    await expect(manager.close("unknown")).rejects.toThrow("agent with id unknown not found");
  });

  it("does not start a queued descendant while closing its running parent", async () => {
    manager = new AgentManager(undefined, 1);
    const parentSession = {
      ...mockSession(),
      sessionManager: { getSessionId: () => "parent-agent-session" },
    };
    vi.mocked(runAgent).mockImplementationOnce(async (_parent, _type, _prompt, options) => {
      options.onSessionCreated?.(parentSession);
      await new Promise<void>((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
      });
      return { responseText: "unreachable", session: parentSession };
    });
    const parent = manager.spawn(mockPi, mockCtx, "worker", "parent", {
      description: "parent",
    });
    const child = manager.spawn(mockPi, mockCtx, "worker", "child", { description: "child" });
    manager.getRecord(child)!.parentSessionId = "parent-agent-session";

    await manager.close(parent);

    expect(runAgent).toHaveBeenCalledOnce();
    expect(manager.getRecord(child)).toBeUndefined();
    expect(manager.getClosedRecord(child)).toEqual({ id: child, recoverable: false });
  });

  it("closes the target and descendants represented by parent session ids", async () => {
    manager = new AgentManager();
    const sessions = [mockSession(), mockSession(), mockSession(), mockSession()];
    Object.assign(sessions[0]!, {
      sessionManager: { getSessionId: () => "target-session" },
    });
    Object.assign(sessions[1]!, {
      sessionManager: { getSessionId: () => "child-session" },
    });
    const abortOrder: string[] = [];
    vi.mocked(runAgent).mockImplementation(async (_parent, _type, prompt, options) => {
      const session = sessions.shift()!;
      options.onSessionCreated?.(session);
      await new Promise<void>((_resolve, reject) => {
        options.signal?.addEventListener(
          "abort",
          () => {
            abortOrder.push(prompt);
            reject(new Error("aborted"));
          },
          { once: true },
        );
      });
      return { responseText: "unreachable", session };
    });

    const target = manager.spawn(mockPi, mockCtx, "worker", "target", {
      description: "target",
    });
    const child = manager.spawn(mockPi, mockCtx, "worker", "child", { description: "child" });
    const grandchild = manager.spawn(mockPi, mockCtx, "worker", "grandchild", {
      description: "grandchild",
    });
    const sibling = manager.spawn(mockPi, mockCtx, "worker", "sibling", {
      description: "sibling",
    });
    manager.getRecord(child)!.parentSessionId = "target-session";
    manager.getRecord(grandchild)!.parentSessionId = "child-session";

    await manager.close(target);

    expect(manager.getRecord(target)).toBeUndefined();
    expect(manager.getRecord(child)).toBeUndefined();
    expect(manager.getRecord(grandchild)).toBeUndefined();
    expect(manager.getRecord(sibling)?.status).toBe("running");
    expect(abortOrder).toEqual(["target", "child", "grandchild"]);
  });

  it("aborts descendants before waiting for a stalled parent runner", async () => {
    manager = new AgentManager(undefined, 2);
    const parentSession = {
      ...mockSession(),
      sessionManager: { getSessionId: () => "stalled-parent-session" },
    };
    const childSession = mockSession();
    const abortOrder: string[] = [];
    let rejectParent!: (error: Error) => void;
    vi.mocked(runAgent)
      .mockImplementationOnce((_parent, _type, _prompt, options) => {
        options.onSessionCreated?.(parentSession);
        return new Promise((_resolve, reject) => {
          rejectParent = reject;
          options.signal?.addEventListener("abort", () => abortOrder.push("parent"), {
            once: true,
          });
        });
      })
      .mockImplementationOnce((_parent, _type, _prompt, options) => {
        options.onSessionCreated?.(childSession);
        return new Promise((_resolve, reject) => {
          options.signal?.addEventListener(
            "abort",
            () => {
              abortOrder.push("child");
              reject(new Error("aborted"));
            },
            { once: true },
          );
        });
      });

    const parent = manager.spawn(mockPi, mockCtx, "worker", "parent", {
      description: "parent",
    });
    const child = manager.spawn(mockPi, mockCtx, "worker", "child", { description: "child" });
    manager.getRecord(child)!.parentSessionId = "stalled-parent-session";

    const closing = manager.close(parent);
    await vi.waitFor(() => expect(childSession.dispose).toHaveBeenCalledOnce());

    expect(abortOrder).toEqual(["parent", "child"]);
    expect(manager.getClosedRecord(child)).toEqual({ id: child, recoverable: false });
    expect(manager.getRecord(parent)).toBeDefined();

    rejectParent(new Error("aborted"));
    await expect(closing).resolves.toBe("running");
  });

  it("finishes descendant teardown when the target teardown fails", async () => {
    manager = new AgentManager(undefined, 2);
    const parentSession = {
      ...mockSession(),
      dispose: vi.fn(() => {
        throw new Error("dispose failed");
      }),
      sessionManager: { getSessionId: () => "failing-parent-session" },
    };
    const childSession = mockSession();
    vi.mocked(runAgent)
      .mockImplementationOnce(async (_parent, _type, _prompt, options) => {
        options.onSessionCreated?.(parentSession);
        await new Promise<void>((_resolve, reject) => {
          options.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        });
        return { responseText: "unreachable", session: parentSession };
      })
      .mockImplementationOnce(async (_parent, _type, _prompt, options) => {
        options.onSessionCreated?.(childSession);
        await new Promise<void>((_resolve, reject) => {
          options.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        });
        return { responseText: "unreachable", session: childSession };
      });

    const parent = manager.spawn(mockPi, mockCtx, "worker", "parent", {
      description: "parent",
    });
    const child = manager.spawn(mockPi, mockCtx, "worker", "child", { description: "child" });
    manager.getRecord(child)!.parentSessionId = "failing-parent-session";

    await expect(manager.close(parent)).rejects.toThrow("dispose failed");

    expect(parentSession.dispose).toHaveBeenCalledOnce();
    expect(childSession.dispose).toHaveBeenCalledOnce();
    expect(manager.getClosedRecord(parent)).toEqual({ id: parent, recoverable: false });
    expect(manager.getClosedRecord(child)).toEqual({ id: child, recoverable: false });
    await expect(manager.close(parent)).resolves.toBe("shutdown");
  });
});
