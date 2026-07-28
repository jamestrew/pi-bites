import assert from "node:assert/strict";
import { test } from "vitest";

import { assistantTurnTokens, normalizeProviderUsage } from "../goal-accounting.js";
import {
  assistantMessage,
  createRuntimeHarness,
  emitToolExecutionEnd,
  type RuntimeHarness,
} from "./support/runtime-harness.js";

async function publicUsage(harness: RuntimeHarness): Promise<{
  tokensUsed: number;
  timeUsedSeconds: number;
}> {
  const result = (await harness.runTool("get_goal", {})) as {
    details: { goal: { tokensUsed: number; timeUsedSeconds: number } };
  };
  return result.details.goal;
}

const providerUsageFixtures = [
  {
    name: "Pi canonical uncached input",
    usage: { input: 7, output: 3, cacheRead: 100, cacheWrite: 5, totalTokens: 115 },
    expected: 10,
  },
  {
    name: "provider input containing cached input",
    usage: { input: 112, output: 3, cacheRead: 100, cacheWrite: 5, totalTokens: 115 },
    expected: 10,
  },
  {
    name: "malformed and negative channels",
    usage: {
      input: Number.NaN,
      output: -3,
      cacheRead: Number.POSITIVE_INFINITY,
      cacheWrite: -1,
      totalTokens: Number.NaN,
    },
    expected: 0,
  },
] as const;

for (const fixture of providerUsageFixtures) {
  test(`normalizes ${fixture.name}`, () => {
    const normalized = normalizeProviderUsage(fixture.usage);
    assert.equal(normalized.uncachedInput + normalized.output, fixture.expected);
    assert.equal(
      assistantTurnTokens({ role: "assistant", usage: fixture.usage }),
      fixture.expected,
    );
  });
}

test("cumulative snapshots charge only non-decreasing per-turn deltas", async () => {
  let now = 0;
  const harness = createRuntimeHarness({ monotonicNow: () => now });
  await harness.runTool("create_goal", { objective: "ship", token_budget: 1_000 });
  await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });

  const snapshots = [
    assistantMessage("toolUse", { input: 8, output: 2 }),
    assistantMessage("toolUse", { input: 8, output: 2 }),
    assistantMessage("toolUse", { input: 4, output: 1 }),
  ];

  for (const message of snapshots) {
    await harness.emit("message_update", {
      type: "message_update",
      message,
      assistantMessageEvent: { type: "text_delta", delta: "x" },
    });
  }

  const finalMessage = assistantMessage("toolUse", { input: 11, output: 4 });
  await harness.emit("message_end", { type: "message_end", message: finalMessage });
  assert.equal((await publicUsage(harness)).tokensUsed, 15);

  await emitToolExecutionEnd(harness);
  await harness.emit("turn_end", {
    type: "turn_end",
    turnIndex: 0,
    message: finalMessage,
    toolResults: [],
  });
  assert.equal(harness.snapshot().goal?.usage.tokensUsed, 15);
});

test("goal creation during a turn establishes a fresh usage baseline", async () => {
  let now = 0;
  const harness = createRuntimeHarness({ monotonicNow: () => now });
  await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
  const finalMessage = assistantMessage("toolUse", { input: 100, output: 20 });
  await harness.emit("message_end", { type: "message_end", message: finalMessage });

  await harness.runTool("create_goal", { objective: "new goal" });
  await emitToolExecutionEnd(harness);
  assert.equal(harness.snapshot().goal?.usage.tokensUsed, 0);

  await harness.emit("turn_end", {
    type: "turn_end",
    turnIndex: 0,
    message: finalMessage,
    toolResults: [],
  });
  assert.equal(harness.snapshot().goal?.usage.tokensUsed, 0);
});

test("monotonic elapsed accounting preserves sub-second carry and excludes inactive time", async () => {
  let now = 0;
  const harness = createRuntimeHarness({ monotonicNow: () => now });
  await harness.runCommand("ship");
  await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });

  now = 600;
  await emitToolExecutionEnd(harness);
  assert.equal((await publicUsage(harness)).timeUsedSeconds, 0);

  now = 1_100;
  await emitToolExecutionEnd(harness);
  assert.equal((await publicUsage(harness)).timeUsedSeconds, 1);

  await harness.runCommand("pause");
  now = 20_000;
  await emitToolExecutionEnd(harness);
  assert.equal(harness.snapshot().goal?.usage.activeSeconds, 1);

  await harness.runCommand("resume");
  await harness.emit("turn_start", { type: "turn_start", turnIndex: 1, timestamp: 2 });
  now = 20_900;
  await emitToolExecutionEnd(harness);
  assert.equal((await publicUsage(harness)).timeUsedSeconds, 2);
  now = 21_100;
  await emitToolExecutionEnd(harness);
  assert.equal((await publicUsage(harness)).timeUsedSeconds, 2);
});

test("pause and resume preserve sub-second carry for the same goal", async () => {
  let now = 0;
  const harness = createRuntimeHarness({ monotonicNow: () => now });
  await harness.runCommand("ship");
  await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });

  now = 600;
  await harness.runCommand("pause");
  assert.equal(harness.snapshot().goal?.usage.activeSeconds, 0);

  now = 10_000;
  await harness.runCommand("resume");
  await harness.emit("turn_start", { type: "turn_start", turnIndex: 1, timestamp: 2 });
  now = 10_400;
  await emitToolExecutionEnd(harness);

  assert.equal((await publicUsage(harness)).timeUsedSeconds, 1);
});

test("exact budget equality persists usage and limits before continuation", async () => {
  let now = 0;
  const harness = createRuntimeHarness({ monotonicNow: () => now });
  await harness.runTool("create_goal", { objective: "ship", token_budget: 10 });
  await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
  const finalMessage = assistantMessage("toolUse", { input: 8, output: 2 });
  await harness.emit("message_end", { type: "message_end", message: finalMessage });

  // Budget limiting is durable before Pi starts the tool batch.
  assert.equal(harness.snapshot().goal?.status, "budgetLimited");

  await emitToolExecutionEnd(harness);
  await harness.emit("turn_end", {
    type: "turn_end",
    turnIndex: 0,
    message: finalMessage,
    toolResults: [],
  });

  const result = (await harness.runTool("get_goal", {})) as {
    details: { goal: { status: string; tokensUsed: number }; remainingTokens: number };
  };
  assert.deepEqual(
    {
      status: result.details.goal.status,
      tokensUsed: result.details.goal.tokensUsed,
      remainingTokens: result.details.remainingTokens,
    },
    { status: "budgetLimited", tokensUsed: 10, remainingTokens: 0 },
  );
  assert.equal(
    harness.sentMessages.filter(
      ({ message }) => (message.details as { kind?: string } | undefined)?.kind === "budget_limit",
    ).length,
    1,
  );
});
