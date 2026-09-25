import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, test, vi } from "vitest";
import { appendAutoModeUsageRecord } from "./usage.js";
import {
  complete,
  createAutoModeHarness,
  createAuthorizationIntegrationHarness,
  execution,
  response,
  rmRequest,
} from "./test/support.js";

vi.mock("./usage.js", () => ({ appendAutoModeUsageRecord: vi.fn(() => Promise.resolve()) }));

function deferReviews() {
  const pending: {
    resolve: (value: AssistantMessage) => void;
    reject: (error: Error) => void;
  }[] = [];
  complete.mockImplementation(
    () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
  );
  return pending;
}

async function warm() {
  const harness = createAutoModeHarness();
  complete.mockResolvedValueOnce(response('{"outcome":"allow"}'));
  await harness.controller.review(rmRequest("rm seed"), harness.ctx as any);
  return harness;
}

function payload(index: number) {
  return JSON.stringify(complete.mock.calls[index]![1]);
}

describe("concurrent reviewer forks", () => {
  test("an old fork cannot overwrite a newer trunk or duplicate/skip appended evidence", async () => {
    const { controller, ctx } = await warm();
    const entries = ctx.sessionManager.buildContextEntries();
    ctx.sessionManager.buildContextEntries = () => entries;
    const deferred = deferReviews();
    const owner = controller.review(rmRequest("rm owner"), ctx as any);
    entries.push({ type: "message", message: { role: "user", content: "NEW_INSTRUCTION" } });
    const fork = controller.review(rmRequest("rm fork"), ctx as any);
    deferred[0]!.resolve(response('{"outcome":"allow"}'));
    await owner;
    const newer = controller.review(rmRequest("rm newer"), ctx as any);
    deferred[2]!.resolve(response('{"outcome":"deny"}'));
    await newer;
    deferred[1]!.resolve(response('{"outcome":"allow"}'));
    await fork;
    complete.mockResolvedValueOnce(response('{"outcome":"allow"}'));
    await controller.review(rmRequest("rm final"), ctx as any);
    expect(payload(4)).toContain("rm newer");
    expect(payload(4)).not.toContain("rm fork");
    expect(payload(4).match(/NEW_INSTRUCTION/g)).toHaveLength(1);
    expect(complete.mock.calls[4]![1].messages).toHaveLength(7);
  });

  test.each(["transport", "parse", "cancel"])(
    "a %s owner cannot poison history or promote a sibling",
    async (failure) => {
      const { controller, ctx } = await warm();
      const deferred = deferReviews();
      const abort = new AbortController();
      const owner = controller.review(rmRequest("rm failed"), {
        ...ctx,
        signal: abort.signal,
      } as any);
      const rejected = expect(owner).rejects.toThrow();
      const sibling = controller.review(rmRequest("rm sibling"), ctx as any);
      if (failure === "transport") deferred[0]!.reject(new Error("offline"));
      else {
        if (failure === "cancel") abort.abort();
        deferred[0]!.resolve(response(failure === "parse" ? "bad json" : '{"outcome":"allow"}'));
      }
      await rejected;
      deferred[1]!.resolve(response('{"outcome":"deny"}'));
      expect((await sibling).outcome).toBe("deny");
      complete.mockResolvedValueOnce(response('{"outcome":"allow"}'));
      await controller.review(rmRequest("rm next"), ctx as any);
      expect(complete.mock.calls[3]![1].messages).toHaveLength(3);
      expect(payload(3)).not.toMatch(/rm failed|rm sibling/);
      expect(complete.mock.calls[3]![2]?.sessionId).toBe(complete.mock.calls[0]![2]?.sessionId);
      expect(appendAutoModeUsageRecord).toHaveBeenCalledTimes(failure === "transport" ? 3 : 4);
    },
  );

  test("fork budget rebuilds and failures do not evict the committed prefix", async () => {
    const { controller, ctx } = createAutoModeHarness();
    complete.mockResolvedValueOnce(response('{"outcome":"allow"}'));
    await controller.review(rmRequest(`rm ${"x".repeat(42_000)}`), ctx as any);
    const deferred = deferReviews();
    const owner = controller.review(rmRequest("rm owner"), ctx as any);
    const fork = controller.review(
      { ...rmRequest(`rm ${"y".repeat(42_000)}`), subagentContext: "CHILD" },
      ctx as any,
    );
    expect(complete.mock.calls[2]![1].messages).toHaveLength(1);
    expect(complete.mock.calls[2]![2]?.sessionId).not.toBe(complete.mock.calls[0]![2]?.sessionId);
    await expect(
      controller.review(
        { ...rmRequest("z".repeat(100_000)), subagentContext: "CHILD" },
        ctx as any,
      ),
    ).rejects.toThrow("whole-request budget");
    deferred[1]!.resolve(response('{"outcome":"allow"}'));
    await fork;
    deferred[0]!.resolve(response("bad json"));
    await expect(owner).rejects.toThrow();
    complete.mockResolvedValueOnce(response('{"outcome":"allow"}'));
    await controller.review(rmRequest("rm next"), ctx as any);
    expect(complete.mock.calls[3]![1].messages).toHaveLength(3);
    expect(complete.mock.calls[3]![2]?.sessionId).toBe(complete.mock.calls[0]![2]?.sessionId);
    expect(payload(3)).not.toMatch(/CHILD|rm owner/);
  });

  test("incompatible forwarded evidence never borrows or replaces parent history", async () => {
    const { controller, ctx } = await warm();
    complete.mockResolvedValue(response('{"outcome":"allow"}'));
    await controller.review(
      { ...rmRequest("rm child"), execution: { cwd: "/other" }, subagentContext: "CHILD_A" },
      ctx as any,
    );
    await controller.review({ ...rmRequest("rm unrelated"), subagentContext: "CHILD_B" }, {
      ...ctx,
      sessionManager: { ...ctx.sessionManager, getSessionId: () => "unrelated" },
    } as any);
    for (const index of [1, 2]) {
      expect(complete.mock.calls[index]![1].messages).toHaveLength(1);
      expect(complete.mock.calls[index]![2]?.sessionId).not.toBe(
        complete.mock.calls[0]![2]?.sessionId,
      );
      expect(payload(index)).not.toContain("rm seed");
    }
    await controller.review(
      { ...rmRequest("rm compatible"), subagentContext: "CHILD_C" },
      ctx as any,
    );
    expect(complete.mock.calls[3]![1].messages).toHaveLength(3);
    expect(payload(3)).not.toMatch(/CHILD_A|CHILD_B/);
    await controller.review(rmRequest("rm next"), ctx as any);
    expect(payload(4)).not.toMatch(/CHILD_A|CHILD_B|CHILD_C/);
    expect(complete.mock.calls[4]![1].messages).toHaveLength(3);
  });

  test("cold forks do not inherit pending actions or promote their results", async () => {
    const { controller, ctx } = createAutoModeHarness();
    const deferred = deferReviews();
    const owner = controller.review(rmRequest("rm owner"), ctx as any);
    const fork = controller.review(rmRequest("rm fork"), ctx as any);
    expect(complete.mock.calls[1]![1].messages).toHaveLength(1);
    expect(payload(1)).not.toContain("rm owner");
    deferred[1]!.resolve(response('{"outcome":"allow"}'));
    await fork;
    deferred[0]!.resolve(response('{"outcome":"deny"}'));
    await owner;
    complete.mockResolvedValueOnce(response('{"outcome":"allow"}'));
    await controller.review(rmRequest("rm next"), ctx as any);
    expect(payload(2)).toContain("rm owner");
    expect(payload(2)).not.toContain("rm fork");
  });

  test("an incompatible execution scope stays cold without disturbing the busy trunk", async () => {
    const { controller, ctx } = await warm();
    const deferred = deferReviews();
    const owner = controller.review(rmRequest("rm owner"), ctx as any);
    const fork = controller.review(
      { ...rmRequest("rm other"), execution: { cwd: "/other" } },
      ctx as any,
    );
    expect(complete.mock.calls[2]![1].messages).toHaveLength(1);
    expect(complete.mock.calls[2]![2]?.sessionId).not.toBe(complete.mock.calls[0]![2]?.sessionId);
    deferred[1]!.resolve(response('{"outcome":"allow"}'));
    await fork;
    deferred[0]!.resolve(response('{"outcome":"allow"}'));
    await owner;
    complete.mockResolvedValueOnce(response('{"outcome":"allow"}'));
    await controller.review(rmRequest("rm next"), ctx as any);
    expect(payload(3)).toContain("rm owner");
    expect(payload(3)).not.toContain("rm other");
    expect(complete.mock.calls[3]![1].messages).toHaveLength(5);
  });

  test("provider-visible message objects are independent from other forks and committed history", async () => {
    const { controller, ctx } = await warm();
    const deferred = deferReviews();
    const owner = controller.review(rmRequest("rm owner"), ctx as any);
    const fork = controller.review(rmRequest("rm fork"), ctx as any);
    complete.mock.calls[2]![1].messages[0]!.content = "MUTATED_BY_PROVIDER";
    expect(payload(1)).not.toContain("MUTATED_BY_PROVIDER");
    deferred[1]!.resolve(response('{"outcome":"deny"}'));
    await fork;
    deferred[0]!.resolve(response("bad json"));
    await expect(owner).rejects.toThrow();
    complete.mockResolvedValueOnce(response('{"outcome":"allow"}'));
    await controller.review(rmRequest("rm next"), ctx as any);
    expect(payload(3)).not.toContain("MUTATED_BY_PROVIDER");
    expect(payload(3)).toContain("rm seed");
  });

  test("parallel launch approvals keep cancellation, errors and usage independent with stale ctx", async () => {
    const { gate, ctx } = createAuthorizationIntegrationHarness();
    complete.mockResolvedValueOnce(response('{"outcome":"allow"}'));
    const session = gate.captureSession(ctx as any);
    const request = (command: string) => ({
      execution,
      toolName: "exec_command" as const,
      command,
      toolCallId: command,
    });
    await session.authorize(request("rm seed"), () => undefined);
    const deferred = deferReviews();
    const cancelled = new AbortController();
    const launches = Array.from({ length: 4 }, () => vi.fn());
    const actions = ["rm cancelled", "rm allowed", "rm denied", "rm error"];
    const results = actions.map((action, index) =>
      session.authorize(
        { ...request(action), signal: index === 0 ? cancelled.signal : undefined },
        launches[index]!,
      ),
    );
    const settled = Promise.allSettled(results);
    // All model reviews launch before any completes; no human-dialog queue is involved.
    await vi.waitFor(() => expect(deferred).toHaveLength(4));
    for (const key of Object.keys(ctx))
      Object.defineProperty(ctx, key, {
        get() {
          throw new Error("stale ctx");
        },
        configurable: true,
      });
    cancelled.abort();
    deferred[3]!.reject(new Error("offline"));
    deferred[2]!.resolve(response('{"outcome":"deny"}'));
    deferred[1]!.resolve(response('{"outcome":"allow"}'));
    deferred[0]!.resolve(response('{"outcome":"allow"}'));
    const outcomes = await settled;
    expect(outcomes.map((outcome) => outcome.status)).toEqual([
      "rejected",
      "fulfilled",
      "rejected",
      "rejected",
    ]);
    expect(launches.map((launch) => launch.mock.calls.length)).toEqual([0, 1, 0, 0]);
    expect(appendAutoModeUsageRecord).toHaveBeenCalledTimes(4);
  });
});
