import { describe, expect, test, vi } from "vitest";
import { createBashGateHarness, subagentEntry } from "./test/harness.js";
describe("shared command authorization", () => {
  test("nested launches and ordinary hooks share allowances and distinct audit IDs", async () => {
    const { gate, ctx, ui, toolCall, pi } = createBashGateHarness();
    ui.select.mockResolvedValue('Allow for session ("rm")');
    const session = gate.captureSession(ctx as any);
    const launch = vi.fn(() => "launched");
    await expect(
      session.authorize(
        { toolCallId: "cell-1/call-1", toolName: "exec_command", command: "rm first" },
        launch,
      ),
    ).resolves.toBe("launched");
    await expect(
      toolCall({ toolName: "bash", input: { command: "rm second" } }, ctx),
    ).resolves.toBeUndefined();
    expect(launch).toHaveBeenCalledOnce();
    expect(ui.select).toHaveBeenCalledOnce();
    expect(pi.appendEntry.mock.calls.map(([, entry]) => entry)).toEqual([
      expect.objectContaining({
        toolCallId: "cell-1/call-1",
        command: "rm first",
        status: "human-approved",
      }),
      expect.objectContaining({
        toolCallId: "tool-call-1",
        command: "rm second",
        status: "human-approved",
      }),
    ]);
  });
});

test("cancelled nested review settles promptly and a late allow never launches", async () => {
  const reviewResult = Promise.withResolvers<{ outcome: "allow" }>();
  const review = vi.fn(() => reviewResult.promise);
  const { gate, ctx, pi } = createBashGateHarness([], false, { isEnabled: () => true, review });
  const controller = new AbortController();
  const launch = vi.fn();
  const pending = gate.captureSession(ctx as any).authorize(
    {
      toolCallId: "cell/cancelled",
      toolName: "exec_command",
      command: "rm first",
      signal: controller.signal,
    },
    launch,
  );
  const settled = expect(pending).rejects.toThrow(/cancel/i);
  await vi.waitFor(() => expect(review).toHaveBeenCalledOnce());
  controller.abort();
  await settled;
  reviewResult.resolve({ outcome: "allow" });
  await Promise.resolve();
  expect(launch).not.toHaveBeenCalled();
  expect(pi.appendEntry.mock.calls.map(([, entry]) => entry)).toEqual([
    expect.objectContaining({ toolCallId: "cell/cancelled", status: "blocked" }),
  ]);
});

test("parallel nested requests queue human dialogs and recheck session allowances", async () => {
  const { gate, ctx, ui } = createBashGateHarness();
  const firstChoice = Promise.withResolvers<string>();
  ui.select.mockImplementationOnce(() => firstChoice.promise);
  const session = gate.captureSession(ctx as any);
  const launch = vi.fn();
  const first = session.authorize(
    { toolCallId: "cell/1", toolName: "exec_command", command: "rm first" },
    launch,
  );
  await vi.waitFor(() => expect(ui.select).toHaveBeenCalledOnce());
  const second = session.authorize(
    { toolCallId: "cell/2", toolName: "exec_command", command: "rm second" },
    launch,
  );
  const safe = session.authorize(
    { toolCallId: "cell/3", toolName: "exec_command", command: "ls" },
    launch,
  );
  await safe;
  expect(ui.select).toHaveBeenCalledOnce();
  firstChoice.resolve('Allow for session ("rm")');
  await Promise.all([first, second]);
  expect(ui.select).toHaveBeenCalledOnce();
  expect(launch).toHaveBeenCalledTimes(3);
});

function nestedRequest(toolCallId: string, signal?: AbortSignal) {
  return { toolCallId, toolName: "exec_command" as const, command: `rm ${toolCallId}`, signal };
}

test.each(["queued", "displayed"])(
  "cancelling a %s dialog never grants a session allowance",
  async (stage) => {
    const { gate, ctx, ui } = createBashGateHarness();
    const choice = Promise.withResolvers<string>();
    ui.select.mockImplementationOnce(() => choice.promise);
    const session = gate.captureSession(ctx as any);
    const controller = new AbortController();
    const launch = vi.fn();
    const first = session.authorize(
      nestedRequest("first", stage === "displayed" ? controller.signal : undefined),
      launch,
    );
    const firstResult = Promise.allSettled([first]);
    await vi.waitFor(() => expect(ui.select).toHaveBeenCalledOnce());
    const second = session.authorize(
      nestedRequest("second", stage === "queued" ? controller.signal : undefined),
      launch,
    );
    const secondResult = Promise.allSettled([second]);
    controller.abort();
    const cancelled = stage === "queued" ? await secondResult : await firstResult;
    expect(cancelled[0].status).toBe("rejected");
    choice.resolve(stage === "displayed" ? 'Allow for session ("rm")' : "Allow");
    await Promise.all([firstResult, secondResult]);
    // A cancelled late session allowance cannot make this launch bypass the gate.
    await expect(session.authorize(nestedRequest("third"), launch)).rejects.toThrow(/denied/);
    expect(launch).toHaveBeenCalledTimes(stage === "queued" ? 1 : 0);
    expect(ui.select).toHaveBeenCalledTimes(stage === "queued" ? 2 : 3);
  },
);

test("session replacement invalidates captured ownership without touching stale context getters", async () => {
  const { gate, ctx, ui, pi, sessionShutdown, sessionStart } = createBashGateHarness();
  const choice = Promise.withResolvers<string>();
  ui.select.mockImplementationOnce(() => choice.promise);
  let stale = false;
  const guarded = new Proxy(ctx, {
    get(target, key) {
      if (stale) throw new Error("stale ctx getter");
      return Reflect.get(target, key);
    },
  });
  const session = gate.captureSession(guarded as any);
  const launch = vi.fn();
  const result = session.authorize(nestedRequest("old"), launch);
  const blocked = expect(result).rejects.toThrow(/owning session changed/);
  await vi.waitFor(() => expect(ui.select).toHaveBeenCalledOnce());
  sessionShutdown();
  stale = true;
  sessionStart();
  await blocked;
  choice.resolve('Allow for session ("rm")');
  await expect(session.authorize(nestedRequest("old-late"), launch)).rejects.toThrow(
    /owning session changed/,
  );
  await expect(
    gate.captureSession(ctx as any).authorize(nestedRequest("new"), launch),
  ).rejects.toThrow(/denied/);
  expect(launch).not.toHaveBeenCalled();
  expect(pi.appendEntry.mock.calls.map(([, entry]) => entry)).toEqual([
    expect.objectContaining({ toolCallId: "old", status: "blocked" }),
    expect.objectContaining({ toolCallId: "new", status: "blocked" }),
  ]);
});

test("parallel reviewers keep unique command identities and denial only blocks its own launch", async () => {
  const firstReview = Promise.withResolvers<{ outcome: "deny" }>();
  const secondReview = Promise.withResolvers<{ outcome: "allow" }>();
  const review = vi
    .fn()
    .mockImplementationOnce(() => firstReview.promise)
    .mockImplementationOnce(() => secondReview.promise);
  const { gate, ctx, pi } = createBashGateHarness(
    [],
    false,
    { isEnabled: () => true, review },
    false,
  );
  const session = gate.captureSession(ctx as any);
  const blockedLaunch = vi.fn();
  const allowedLaunch = vi.fn(() => "running");
  const first = session.authorize(nestedRequest("cell/one"), blockedLaunch);
  const denied = expect(first).rejects.toThrow(/Automode denied/);
  const second = session.authorize(nestedRequest("cell/two"), allowedLaunch);
  await vi.waitFor(() => expect(review).toHaveBeenCalledTimes(2));
  firstReview.resolve({ outcome: "deny" });
  await denied;
  secondReview.resolve({ outcome: "allow" });
  await expect(second).resolves.toBe("running");
  expect(blockedLaunch).not.toHaveBeenCalled();
  expect(allowedLaunch).toHaveBeenCalledOnce();
  expect(pi.appendEntry.mock.calls.map(([, entry]) => entry)).toEqual([
    expect.objectContaining({ toolCallId: "cell/one", command: "rm cell/one", status: "blocked" }),
    expect.objectContaining({
      toolCallId: "cell/two",
      command: "rm cell/two",
      status: "reviewer-approved",
    }),
  ]);
});

test.each(["review", "escalation"])(
  "nested %s failures cannot invoke the executor",
  async (failure) => {
    const review =
      failure === "review"
        ? vi.fn().mockRejectedValue(new Error("review unavailable"))
        : vi.fn().mockResolvedValue({ outcome: "deny" });
    const { gate, ctx, ui } = createBashGateHarness([], false, { isEnabled: () => true, review });
    ui.select.mockRejectedValue(new Error("UI unavailable"));
    const launch = vi.fn();
    await expect(
      gate.captureSession(ctx as any).authorize(nestedRequest("failure"), launch),
    ).rejects.toThrow(/failed closed|denied/);
    expect(launch).not.toHaveBeenCalled();
  },
);

test("nested parent broker waits cancel and ignore late allow-session replies", async () => {
  const { gate, ctx, pi, eventHandlers, ui } = createBashGateHarness([
    subagentEntry({ agentId: "child", bashGatePolicy: "prompt" }),
  ]);
  let replyChannel = "";
  eventHandlers.set("subagents:bash_gate:approval", (data: any) => {
    pi.events.emit(`subagents:bash_gate:approval:ack:${data.requestId}`, {});
    replyChannel = `subagents:bash_gate:approval:reply:${data.requestId}`;
  });
  const controller = new AbortController();
  const launch = vi.fn();
  const pending = gate
    .captureSession(ctx as any)
    .authorize(nestedRequest("child-command", controller.signal), launch);
  const blocked = expect(pending).rejects.toThrow(/cancel/);
  await vi.waitFor(() => expect(replyChannel).not.toBe(""));
  controller.abort();
  await blocked;
  expect(eventHandlers.has(replyChannel)).toBe(false);
  pi.events.emit(replyChannel, {
    result: { outcome: "allow-session", authorization: "human-approved" },
  });
  expect(launch).not.toHaveBeenCalled();
  expect(ui.select).not.toHaveBeenCalled();
});

test.each(["completed", "cancelled"])(
  "tree navigation %s keeps pending audit records on their owning branch and permits fresh requests",
  async (navigation) => {
    const { gate, ctx, ui, pi, beforeTree } = createBashGateHarness();
    const choice = Promise.withResolvers<string>();
    ui.select.mockImplementationOnce(() => choice.promise);
    let branch = "source";
    const persisted: { branch: string; status: unknown }[] = [];
    pi.appendEntry.mockImplementation((_kind, data) => {
      persisted.push({ branch, status: (data as { status: unknown }).status });
      return 0;
    });
    const captured = gate.captureSession(ctx as any);
    const launch = vi.fn();
    const pending = captured.authorize(nestedRequest("before-navigation"), launch);
    const rejected = expect(pending).rejects.toThrow(/owning session changed/);
    await vi.waitFor(() => expect(ui.select).toHaveBeenCalledOnce());
    beforeTree();
    // Pi changes the branch only after all before-tree handlers have run. A later
    // handler can cancel, in which case no session_tree event follows.
    expect(persisted).toEqual([{ branch: "source", status: "blocked" }]);
    if (navigation === "completed") branch = "destination";
    choice.resolve("Allow");
    await rejected;
    await expect(captured.authorize(nestedRequest("stale-owner"), launch)).rejects.toThrow(
      /owning session changed/,
    );
    await gate
      .captureSession(ctx as any)
      .authorize({ ...nestedRequest("fresh-owner"), command: "ls" }, launch);
    expect(launch).toHaveBeenCalledOnce();
    expect(persisted).toEqual([
      { branch: "source", status: "blocked" },
      { branch, status: "not-reviewed" },
    ]);
  },
);
