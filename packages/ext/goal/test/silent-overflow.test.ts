import assert from "node:assert/strict";
import { test, vi } from "vitest";

import { CUSTOM_ENTRY_TYPE } from "../types.js";
import {
  assistantMessage,
  createRuntimeHarness,
  emitHostSessionCompact,
  emitSilentContextOverflow,
  flushContinuationScheduler,
  sessionShutdownEvent,
} from "./support/runtime-harness.js";

function silentOverflowMessage() {
  return assistantMessage("stop", { input: 130_000, output: 0, cacheRead: 0 });
}

async function startGoal(harness: ReturnType<typeof createRuntimeHarness>): Promise<void> {
  await harness.runCommand("ship it");
  const queued = harness.sentMessages[0];
  assert.ok(queued);
  await harness.emit("before_agent_start", {
    type: "before_agent_start",
    prompt: String(queued.message.content),
    systemPrompt: "",
    systemPromptOptions: {},
  });
  harness.sentMessages.length = 0;
}

test("silent overflow persists host recovery and suppresses continuation", async () => {
  const harness = createRuntimeHarness({ contextWindow: 128_000 });
  await startGoal(harness);

  await emitSilentContextOverflow(harness, 0, silentOverflowMessage());

  assert.equal(harness.snapshot().goal?.status, "active");
  assert.equal(harness.sentMessages.length, 0);
  assert.match(harness.footerStatuses.at(-1) ?? "", /Goal recovery pending/);
  assert.equal(
    harness.entries.some(
      (entry) =>
        entry.type === "custom" &&
        entry.customType === CUSTOM_ENTRY_TYPE &&
        (entry.data as { kind?: string }).kind === "host_overflow_cap_reset",
    ),
    true,
  );
});

test("host compaction clears pending overflow and a successful retry continues once", async () => {
  vi.useFakeTimers();
  try {
    const harness = createRuntimeHarness({ contextWindow: 128_000 });
    await startGoal(harness);
    await emitSilentContextOverflow(harness, 0, silentOverflowMessage());

    await emitHostSessionCompact(harness, { willRetry: true });
    assert.equal(harness.sentMessages.length, 0);

    await harness.emit("agent_start", { type: "agent_start" });
    await harness.emit("turn_start", { type: "turn_start", turnIndex: 1, timestamp: 2 });
    const success = assistantMessage("stop", { input: 10, output: 2 });
    await harness.emit("turn_end", {
      type: "turn_end",
      turnIndex: 1,
      message: success,
      toolResults: [],
    });
    await harness.emit("agent_end", { type: "agent_end", messages: [success] });
    flushContinuationScheduler();

    assert.equal(harness.snapshot().goal?.status, "active");
    assert.equal(harness.sentMessages.length, 1);
  } finally {
    vi.useRealTimers();
  }
});

test("a repeated silent overflow after host compaction durably blocks the goal", async () => {
  vi.useFakeTimers();
  try {
    const harness = createRuntimeHarness({ contextWindow: 128_000 });
    await startGoal(harness);
    await emitSilentContextOverflow(harness, 0, silentOverflowMessage());
    await emitHostSessionCompact(harness, { willRetry: true });
    await harness.emit("agent_start", { type: "agent_start" });

    await emitSilentContextOverflow(harness, 1, silentOverflowMessage());
    flushContinuationScheduler();

    assert.equal(harness.snapshot().goal?.status, "blocked");
    assert.equal(harness.sentMessages.length, 0);
    assert.equal(harness.footerStatuses.at(-1), "Goal blocked (/goal resume)");

    await harness.reloadSession();
    assert.equal(harness.snapshot().goal?.status, "blocked");
  } finally {
    vi.useRealTimers();
  }
});

test("shutdown converts pending silent-overflow recovery to blocked", async () => {
  const harness = createRuntimeHarness({ contextWindow: 128_000 });
  await startGoal(harness);
  await emitSilentContextOverflow(harness, 0, silentOverflowMessage());

  await harness.emit("session_shutdown", sessionShutdownEvent());

  assert.equal(harness.snapshot().goal?.status, "blocked");
  assert.equal(harness.sentMessages.length, 0);
});
