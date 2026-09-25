import type { AssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, test, vi } from "vitest";
import {
  complete,
  createAutoModeHarness,
  createAuthorizationIntegrationHarness,
  execution,
  model,
  response,
  rmRequest,
} from "./test/support.js";

vi.mock("./usage.js", () => ({ appendAutoModeUsageRecord: vi.fn(() => Promise.resolve()) }));

describe("bounded reviewer conversation lifecycle", () => {
  test("a late real reviewer allow cannot launch a nested command after session replacement", async () => {
    const { gate, ctx, lifecycle } = createAuthorizationIntegrationHarness();
    let resolve!: (value: AssistantMessage) => void;
    let started!: () => void;
    const invocation = new Promise<void>((done) => {
      started = done;
    });
    complete.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
          started();
        }),
    );
    const launch = vi.fn();
    const pending = gate
      .captureSession(ctx as any)
      .authorize(
        { execution, toolName: "exec_command", command: "rm stale", toolCallId: "stale" },
        launch,
      );
    const rejected = expect(pending).rejects.toThrow();
    await invocation;
    for (const handler of lifecycle.get("session_shutdown") ?? []) handler({}, ctx);
    resolve(response('{"outcome":"allow"}'));
    await rejected;
    expect(launch).not.toHaveBeenCalled();
  });

  test("a context rewrite during a pending review rejects its late allow", async () => {
    const { controller, ctx } = createAutoModeHarness();
    const manager = SessionManager.inMemory("/repo");
    const id = manager.appendMessage({
      role: "user",
      content: "Remove generated files",
      timestamp: 1,
    });
    ctx.sessionManager = manager as any;
    let resolve!: (value: AssistantMessage) => void;
    complete.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const pending = controller.review(rmRequest("rm stale"), ctx as any);
    manager.appendContextEdit(id, { content: "Do not delete files" });
    resolve(response('{"outcome":"allow"}'));
    await expect(pending).rejects.toThrow("context changed");
  });

  test("context edits rebuild from projected evidence rather than resurrecting replaced or omitted instructions", async () => {
    const { controller, ctx } = createAutoModeHarness();
    const manager = SessionManager.inMemory("/repo");
    const id = manager.appendMessage({
      role: "user",
      content: "ORIGINAL_AUTHORIZATION",
      timestamp: 1,
    });
    ctx.sessionManager = manager as any;
    complete.mockResolvedValue(response('{"outcome":"allow"}'));
    await controller.review(rmRequest("rm first"), ctx as any);
    manager.appendContextEdit(id, { content: "REPLACED_INSTRUCTION" });
    await controller.review(rmRequest("rm next"), ctx as any);
    expect(complete.mock.calls[1]![1].messages).toHaveLength(1);
    expect(JSON.stringify(complete.mock.calls[1]![1])).toContain("REPLACED_INSTRUCTION");
    expect(JSON.stringify(complete.mock.calls[1]![1])).not.toContain("ORIGINAL_AUTHORIZATION");
    manager.appendContextEdit(id, null);
    await controller.review(rmRequest("rm last"), ctx as any);
    expect(complete.mock.calls[2]![1].messages).toHaveLength(1);
    expect(JSON.stringify(complete.mock.calls[2]![1])).not.toMatch(
      /ORIGINAL_AUTHORIZATION|REPLACED_INSTRUCTION/,
    );
  });

  test("rebuilds deterministically at the whole-request bound without truncating the action", async () => {
    const { controller, ctx } = createAutoModeHarness();
    complete.mockResolvedValue(response('{"outcome":"allow"}'));
    const command = `rm ${"x".repeat(42_000)} END`;
    await controller.review(rmRequest(command), ctx as any);
    await controller.review(rmRequest(command), ctx as any);
    expect(complete.mock.calls[1]![1].messages).toHaveLength(1);
    expect(JSON.stringify(complete.mock.calls[1]![1].messages)).toContain(command);
    expect(complete.mock.calls[1]![2]?.sessionId).not.toBe(complete.mock.calls[0]![2]?.sessionId);
    await expect(controller.review(rmRequest("x".repeat(100_000)), ctx as any)).rejects.toThrow(
      "whole-request budget",
    );
    await expect(
      controller.review({ ...rmRequest("rm x"), subagentContext: "x".repeat(100_000) }, ctx as any),
    ).rejects.toThrow("whole-request budget");
    expect(complete).toHaveBeenCalledTimes(2);
  });

  test("reserves Pi's expanded thinking output within the whole model context", async () => {
    const { controller, ctx, configRef } = createAutoModeHarness();
    ctx.model = { ...model, contextWindow: 40_000 };
    configRef.current.autoMode = { thinking: "high" };
    await expect(controller.review(rmRequest("x".repeat(12_000)), ctx as any)).rejects.toThrow(
      "whole-request budget",
    );
    expect(complete).not.toHaveBeenCalled();
    configRef.current.autoMode = { thinking: "low" };
    complete.mockResolvedValue(response('{"outcome":"allow"}'));
    await controller.review(rmRequest("x".repeat(12_000)), ctx as any);
    expect(complete).toHaveBeenCalledOnce();
  });

  test("respects the selected model's context window including policy and output reserve", async () => {
    const { controller, ctx } = createAutoModeHarness();
    ctx.model = { ...model, contextWindow: 20_000 };
    await expect(controller.review(rmRequest("x".repeat(3_000)), ctx as any)).rejects.toThrow(
      "whole-request budget",
    );
    expect(complete).not.toHaveBeenCalled();
  });

  test.each([
    "session_start",
    "session_shutdown",
    "session_before_tree",
    "session_compact",
    "session_before_fork",
    "model_select",
  ])(
    "%s invalidates committed and pending history with throwing stale ctx getters",
    async (event) => {
      const { controller, ctx, lifecycle } = createAutoModeHarness();
      complete.mockResolvedValueOnce(response('{"outcome":"allow"}'));
      await controller.review(rmRequest("rm first"), ctx as any);
      let resolve!: (value: AssistantMessage) => void;
      complete.mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      );
      let stale = false;
      const guarded = Object.fromEntries(Object.keys(ctx).map((key) => [key, undefined]));
      for (const key of Object.keys(ctx) as (keyof typeof ctx)[]) {
        Object.defineProperty(guarded, key, {
          get() {
            if (stale) throw new Error("stale ctx");
            return ctx[key];
          },
        });
      }
      const pending = controller.review(rmRequest("rm pending"), guarded as any);
      let resolveFork!: (value: AssistantMessage) => void;
      complete.mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolveFork = done;
          }),
      );
      const fork = controller.review(
        { ...rmRequest("rm fork"), subagentContext: "CHILD" },
        guarded as any,
      );
      stale = true;
      lifecycle.get(event)!({}, ctx);
      resolve(response('{"outcome":"allow"}'));
      await expect(pending).rejects.toThrow("context changed");
      resolveFork(response('{"outcome":"allow"}'));
      await expect(fork).rejects.toThrow("context changed");
      complete.mockResolvedValueOnce(response('{"outcome":"deny"}'));
      await controller.review(rmRequest("rm next"), ctx as any);
      expect(complete.mock.calls[3]![1].messages).toHaveLength(1);
      expect(complete.mock.calls[3]![2]?.sessionId).not.toBe(complete.mock.calls[0]![2]?.sessionId);
    },
  );

  test.each(["policy", "model", "session", "branch", "rewrite", "cwd"])(
    "rebuilds after incompatible %s changes",
    async (change) => {
      const { controller, ctx, configRef, branch } = createAutoModeHarness();
      const entries = ctx.sessionManager.buildContextEntries();
      ctx.sessionManager.buildContextEntries = () => entries;
      branch.push({ type: "custom", id: "old", customType: "test" });
      complete.mockResolvedValue(response('{"outcome":"allow"}'));
      await controller.review(rmRequest("rm first"), ctx as any);
      let request = rmRequest("rm next");
      if (change === "policy") configRef.current.autoMode = { policy: "new policy" };
      if (change === "model") ctx.model = { ...model, id: "new" };
      if (change === "session") ctx.sessionManager.getSessionId = () => "new-session";
      if (change === "branch") branch[0] = { type: "custom", id: "other", customType: "test" };
      if (change === "rewrite")
        entries[0] = {
          type: "message",
          message: { role: "user", content: "Do not delete anything" },
        };
      if (change === "cwd") request = { ...request, execution: { cwd: "/other" } };
      await controller.review(request, ctx as any);
      expect(complete.mock.calls[1]![1].messages).toHaveLength(1);
      expect(complete.mock.calls[1]![2]?.sessionId).not.toBe(complete.mock.calls[0]![2]?.sessionId);
    },
  );

  test.each(["parse", "transport", "cancel"])("does not commit a %s failure", async (failure) => {
    const { controller, ctx } = createAutoModeHarness();
    complete.mockResolvedValueOnce(response('{"outcome":"allow"}'));
    await controller.review(rmRequest("rm first"), ctx as any);
    const abort = new AbortController();
    complete.mockImplementationOnce(async () => {
      if (failure === "transport") throw new Error("offline");
      if (failure === "cancel") abort.abort();
      return response(failure === "parse" ? "bad json" : '{"outcome":"allow"}');
    });
    await expect(
      controller.review(rmRequest("rm failed"), { ...ctx, signal: abort.signal } as any),
    ).rejects.toThrow();
    complete.mockResolvedValueOnce(response('{"outcome":"deny"}'));
    await controller.review(rmRequest("rm next"), ctx as any);
    expect(complete.mock.calls[2]![1].messages).toHaveLength(3);
    expect(JSON.stringify(complete.mock.calls[2]![1])).not.toContain("rm failed");
    expect(complete.mock.calls[2]![2]?.sessionId).toBe(complete.mock.calls[0]![2]?.sessionId);
  });

  test.each([false, true])(
    "compatible forks share a prefix with reverse completion = %s",
    async (reverse) => {
      const { controller, ctx } = createAutoModeHarness();
      complete.mockResolvedValueOnce(response('{"outcome":"allow"}'));
      await controller.review(rmRequest("rm first"), ctx as any);
      const resolvers: ((value: AssistantMessage) => void)[] = [];
      complete.mockImplementation(() => new Promise((resolve) => resolvers.push(resolve)));
      const owner = controller.review(rmRequest("rm owner"), ctx as any);
      const sibling = controller.review(rmRequest("rm sibling"), ctx as any);
      const child = controller.review(
        { ...rmRequest("rm child"), subagentContext: "CHILD_ONLY" },
        ctx as any,
      );
      const payloads = complete.mock.calls.slice(1).map((call) => structuredClone(call[1]));
      for (const index of [1, 2, 3]) {
        expect(complete.mock.calls[index]![2]?.sessionId).toBe(
          complete.mock.calls[0]![2]?.sessionId,
        );
        expect(complete.mock.calls[index]![1].messages).toHaveLength(3);
        expect(complete.mock.calls[index]![1].messages.slice(0, 2)).toEqual(
          payloads[0]!.messages.slice(0, 2),
        );
      }
      expect(JSON.stringify(payloads[0])).not.toMatch(/rm sibling|rm child|CHILD_ONLY/);
      expect(JSON.stringify(payloads[1])).not.toMatch(/rm owner|rm child|CHILD_ONLY/);
      expect(JSON.stringify(payloads[2])).not.toMatch(/rm owner|rm sibling/);
      expect(JSON.stringify(payloads[2])).toContain("never direct human authorization");
      const order = reverse ? [2, 1, 0] : [0, 1, 2];
      const pending = [owner, sibling, child];
      for (const index of order) {
        resolvers[index]!(response(index === 1 ? '{"outcome":"deny"}' : '{"outcome":"allow"}'));
        expect((await pending[index])!.outcome).toBe(index === 1 ? "deny" : "allow");
      }
      expect(complete.mock.calls.slice(1).map((call) => call[1])).toEqual(payloads);
      complete.mockResolvedValueOnce(response('{"outcome":"allow"}'));
      await controller.review(rmRequest("rm next"), ctx as any);
      const next = complete.mock.calls[4]![1];
      expect(next.messages).toHaveLength(5);
      expect(JSON.stringify(next)).toContain("rm owner");
      expect(JSON.stringify(next)).not.toMatch(/rm sibling|rm child|CHILD_ONLY/);
    },
  );
});
