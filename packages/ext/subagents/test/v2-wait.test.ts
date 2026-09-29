import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, expect, it, vi } from "vitest";
import { harness } from "./helpers/v2-harness.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
  vi.useRealTimers();
});

it("waits for caller mail without consuming it or returning its contents", async () => {
  const h = harness(cleanup);
  h.pi.getActiveTools = () => ["wait_agent", "send_message"];
  await h.emit("session_start");
  const waits = [h.call("wait_agent", {}), h.call("wait_agent", {})];
  await h.call("send_message", { target: "/root", message: "one copy" });
  for (const wait of waits)
    expect((await wait).value).toEqual({ message: "Wait completed.", timed_out: false });
  expect((await h.call("wait_agent", {})).value).toEqual({
    message: "Wait completed.",
    timed_out: false,
  });
  expect(h.pi.sendMessage).toHaveBeenCalledTimes(1);
  const message = h.pi.sendMessage.mock.calls[0][0];
  await h.emit("context", { messages: [{ role: "custom", ...message }] });
  vi.useFakeTimers();
  const empty = h.call("wait_agent", {});
  await vi.advanceTimersByTimeAsync(30_000);
  expect((await empty).value).toEqual({ message: "Wait timed out.", timed_out: true });
});

it("validates only integer timeout, clamps low values and uses the pinned summaries", async () => {
  const h = harness(cleanup);
  h.pi.getActiveTools = () => ["wait_agent"];
  await h.emit("session_start");
  for (const args of [
    { targets: ["a"] },
    { timeout_ms: "1" },
    { timeout_ms: null },
    { timeout_ms: 1.5 },
    { timeout_ms: Infinity },
    { timeout_ms: 3_600_001 },
  ])
    await expect(h.call("wait_agent", args)).rejects.toThrow();
  vi.useFakeTimers();
  const wait = h.call("wait_agent", { timeout_ms: -1 });
  await vi.advanceTimersByTimeAsync(9_999);
  expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(1);
  expect((await wait).value).toEqual({
    message: "Wait timed out.\n\nRequested timeout of -1ms was clamped to the minimum of 10000ms.",
    timed_out: true,
  });
});

it("cancels stale waits without consuming mail or dereferencing expired contexts", async () => {
  const h = harness(cleanup);
  h.pi.getActiveTools = () => ["wait_agent", "send_message"];
  await h.emit("session_start");
  const operation = h.controller.capture(h.ctx);
  const original = Object.getOwnPropertyDescriptors(h.ctx);
  vi.useFakeTimers();
  const owner = new AbortController();
  const wait = operation.execute(
    "wait_agent",
    {},
    { callerId: operation.callerId, callId: "wait", signal: owner.signal },
  );
  const rejected = expect(wait).rejects.toThrow("cancelled");
  for (const key of Object.keys(h.ctx))
    Object.defineProperty(h.ctx, key, {
      configurable: true,
      get() {
        throw new Error("stale ctx");
      },
    });
  owner.abort();
  await rejected;
  expect(vi.getTimerCount()).toBe(0);
  Object.defineProperties(h.ctx, original);
  const replaced = h.call("wait_agent", {});
  const replacedRejected = expect(replaced).rejects.toThrow("cancelled");
  await h.emit("session_before_switch");
  await replacedRejected;
  expect(vi.getTimerCount()).toBe(0);
  await h.emit("session_start");
  await h.call("send_message", { target: "/root", message: "retained" });
  h.controller.invalidate();
  expect((await h.call("wait_agent", {})).value).toEqual({
    message: "Wait completed.",
    timed_out: false,
  });
});

it("renders wait outcomes once in the call row, with bounded width and styled details", async () => {
  const h = harness(cleanup);
  const tool = h.direct.get("wait_agent");
  const theme = {
    bold: (s: string) => `<b>${s}</b>`,
    fg: (c: string, s: string) => `<${c}>${s}</${c}>`,
  };
  for (const [summary, label] of [
    ["Wait completed.", "completed"],
    ["Wait timed out.", "timed out"],
    ["Wait interrupted by new input.", "interrupted by new input"],
  ]) {
    for (const expanded of [false, true]) {
      const context = { state: {}, expanded, isError: false };
      const result = tool.renderResult(
        { content: [], details: { status: summary } },
        {},
        theme,
        context,
      );
      expect(result.render(120)).toEqual([]);
      const row = tool.renderCall({}, theme, context).render(120).join("\n");
      expect(row).toBe(`<b>wait_agent</b><accent> ${label}</accent>`);
    }
  }
  for (const error of ["Wait cancelled.", "Mailbox is unavailable"]) {
    const context = { state: {}, expanded: false, isError: true };
    tool.renderResult({ content: [{ type: "text", text: error }] }, {}, theme, context);
    expect(tool.renderCall({}, theme, context).render(120).join("\n")).toContain(
      `\n\n<dim>Error: ${error}</dim>`,
    );
  }
  const plain = { bold: (s: string) => s, fg: (_c: string, s: string) => s };
  const lines = tool
    .renderCall({ timeout_ms: 3600000 }, plain, { state: {}, expanded: false })
    .render(12);
  expect(lines.every((line: string) => visibleWidth(line) <= 12)).toBe(true);
});

it("waits for queued input, snapshots its getter, and removes polling on abort or replacement", async () => {
  const h = harness(cleanup);
  h.pi.getActiveTools = () => ["wait_agent"];
  await h.emit("session_start");
  vi.useFakeTimers();
  let pending = false;
  const predicate = vi.fn(() => pending);
  Object.defineProperty(h.ctx, "hasPendingMessages", { configurable: true, get: () => predicate });
  const wait = h.call("wait_agent", {});
  await h.emit("input", { source: "interactive" });
  Object.defineProperty(h.ctx, "hasPendingMessages", {
    configurable: true,
    get() {
      throw new Error("expired getter");
    },
  });
  await vi.advanceTimersByTimeAsync(100);
  expect(vi.getTimerCount()).toBe(2);
  pending = true;
  await vi.advanceTimersByTimeAsync(25);
  expect((await wait).value).toEqual({
    message: "Wait interrupted by new input.",
    timed_out: false,
  });
  expect(vi.getTimerCount()).toBe(0);

  pending = false; // Pi consumes the input before the next turn.
  Object.defineProperty(h.ctx, "hasPendingMessages", { configurable: true, value: () => false });
  const replacement = h.call("wait_agent", {});
  const rejected = expect(replacement).rejects.toThrow("cancelled");
  await h.emit("input", { source: "rpc" });
  await h.emit("session_before_switch");
  await rejected;
  expect(vi.getTimerCount()).toBe(0);
  const calls = predicate.mock.calls.length;
  await vi.advanceTimersByTimeAsync(30_000);
  expect(predicate).toHaveBeenCalledTimes(calls);
});

it("cancels a guarded input predicate invalidated before lifecycle cleanup", async () => {
  const h = harness(cleanup);
  h.pi.getActiveTools = () => ["wait_agent"];
  await h.emit("session_start");
  vi.useFakeTimers();
  let invalid = false;
  h.ctx.hasPendingMessages = () => {
    if (invalid) throw new Error("Runtime replaced");
    return false;
  };
  const wait = h.call("wait_agent", {});
  const rejected = expect(wait).rejects.toThrow("cancelled");
  await h.emit("input", { source: "interactive" });
  invalid = true;
  await vi.advanceTimersByTimeAsync(25);
  await rejected;
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps queued user input observable across consecutive waits until Pi consumes it", async () => {
  const h = harness(cleanup);
  h.pi.getActiveTools = () => ["wait_agent"];
  await h.emit("session_start");
  vi.useFakeTimers();
  let pending = true;
  h.ctx.hasPendingMessages = () => pending;
  await h.emit("input", { source: "interactive" });
  for (let i = 0; i < 2; i++) {
    const wait = h.call("wait_agent", {});
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await wait).value).toEqual({
      message: "Wait interrupted by new input.",
      timed_out: false,
    });
  }
  pending = false;
  const consumed = h.call("wait_agent", {});
  await vi.advanceTimersByTimeAsync(30_000);
  expect((await consumed).value).toEqual({ message: "Wait timed out.", timed_out: true });
  expect(vi.getTimerCount()).toBe(0);
});
