import { expect, it, vi } from "vitest";
import { createBashGateHarness } from "./test/harness.js";

it("strict denies reviewer rejection with its rationale and no dialog", async () => {
  const review = vi.fn(async () => ({
    outcome: "deny" as const,
    rationale: "Production deletion",
    risk_level: "high" as const,
    user_authorization: "low" as const,
  }));
  const h = createBashGateHarness([], false, { getMode: () => "auto" as const, review }, true, {
    bashGate: { mode: "strict" },
  });
  const result = await h.toolCall(
    { toolName: "bash", input: { command: "rm -rf /production" } },
    h.ctx,
  );
  expect(result).toMatchObject({
    block: true,
    reason: expect.stringContaining("Production deletion"),
  });
  expect(h.ui.select).not.toHaveBeenCalled();
});

it.each(["auto", "strict"] as const)(
  "%s runs safe commands and reviewer approvals",
  async (mode) => {
    const review = vi.fn().mockResolvedValue({ outcome: "allow" });
    const h = createBashGateHarness([], false, { getMode: () => mode, review }, true, {
      bashGate: { mode },
    });
    const call = (command: string) => h.toolCall({ toolName: "bash", input: { command } }, h.ctx);
    await expect(call("cat README.md")).resolves.toBeUndefined();
    expect(review).not.toHaveBeenCalled();
    await expect(call("rm old-build.txt")).resolves.toBeUndefined();
    expect(review).toHaveBeenCalledOnce();
    expect(h.ui.select).not.toHaveBeenCalled();
  },
);

it("headless auto fails closed like strict and includes the review rationale", async () => {
  const review = vi
    .fn()
    .mockResolvedValue({ outcome: "deny", rationale: "No deployment authorization" });
  const h = createBashGateHarness([], false, { getMode: () => "auto", review }, false);
  expect(
    await h.toolCall({ toolName: "bash", input: { command: "rm build.txt" } }, h.ctx),
  ).toMatchObject({ block: true, reason: expect.stringContaining("No deployment authorization") });
  expect(h.ui.select).not.toHaveBeenCalled();
});

it("strict ignores allowances granted in auto", async () => {
  const review = vi.fn().mockResolvedValue({ outcome: "deny", rationale: "Needs approval" });
  const h = createBashGateHarness([], false, { getMode: () => "auto", review });
  h.ui.select.mockResolvedValue('Allow for session ("rm")');
  const call = () =>
    h.toolCall({ toolName: "bash", input: { command: "rm old-build.txt" } }, h.ctx);
  await expect(call()).resolves.toBeUndefined();
  await h.toggleYolo();
  expect(h.gate.getMode()).toBe("strict");
  expect(await call()).toMatchObject({
    block: true,
    reason: expect.stringContaining("Needs approval"),
  });
  expect(review).toHaveBeenCalledTimes(2);
  expect(h.ui.select).toHaveBeenCalledOnce();
});

it("a mode change during review cannot authorize a late launch", async () => {
  const decision = Promise.withResolvers<any>();
  const review = vi.fn(() => decision.promise);
  const h = createBashGateHarness([], false, { getMode: () => "auto", review });
  const launch = vi.fn();
  const pending = h.gate
    .captureSession(h.ctx as never)
    .authorize(
      { execution: { cwd: "/repo" }, toolName: "bash", toolCallId: "pending", command: "rm file" },
      launch,
    );
  const result = Promise.allSettled([pending]);
  await vi.waitFor(() => expect(review).toHaveBeenCalledOnce());
  await h.toggleYolo();
  decision.resolve({ outcome: "allow" });
  expect((await result)[0].status).toBe("rejected");
  expect(launch).not.toHaveBeenCalled();
});
