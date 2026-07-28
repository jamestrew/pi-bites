import assert from "node:assert/strict";
import { test } from "vitest";

import { createGoalPersistence } from "../goal-persistence.js";
import {
  cloneGoal,
  isGoalCustomEntry,
  reconstructGoal,
  createThreadGoal,
  runtimeUsageEntry,
  setEntry,
} from "../state.js";
import { CUSTOM_ENTRY_TYPE } from "../types.js";
import {
  assistantMessage,
  countGoalSetEntries,
  countGoalUsageEntries,
  createRuntimeHarness,
  emitToolExecutionEnd,
  sessionBeforeCompactEvent,
  sessionCompactEvent,
  sessionShutdownEvent,
} from "./support/runtime-harness.js";

test("duplicate update_goal complete appends only one complete entry", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");

  await harness.runTool("update_goal", { status: "complete" });
  await harness.runTool("update_goal", { status: "complete" });

  const completeSetEntries = harness.entries.filter((entry) => {
    return (
      entry.type === "custom" &&
      entry.customType === CUSTOM_ENTRY_TYPE &&
      isGoalCustomEntry(entry.data) &&
      entry.data.kind === "set" &&
      entry.data.goal.status === "complete"
    );
  });
  assert.equal(completeSetEntries.length, 1);
  assert.equal(harness.snapshot().goal?.status, "complete");
});

test("compaction after complete does not append duplicate runtime entries", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  await harness.runTool("update_goal", { status: "complete" });
  const entryCountAfterComplete = harness.entries.length;

  await harness.emit("session_before_compact", sessionBeforeCompactEvent());
  await harness.emit("session_compact", sessionCompactEvent());

  assert.equal(harness.entries.length, entryCountAfterComplete);
  assert.equal(harness.snapshot().goal?.status, "complete");
});

test("persistence ignores writes for a stale expected incarnation", () => {
  const entries: unknown[] = [];
  const persistence = createGoalPersistence({
    pi: {
      appendEntry(customType, data) {
        entries.push({ customType, data });
      },
    },
  });
  const goal = createThreadGoal("current");
  assert.equal(persistence.persistGoalSnapshot(goal, "tool", null), true);
  const staleUpdate = cloneGoal(goal);
  staleUpdate.usage.tokensUsed = 10;

  assert.equal(persistence.persistGoalSnapshot(staleUpdate, "runtime", "replaced-goal"), false);
  assert.equal(entries.length, 1);
  assert.equal(persistence.getGoal()?.usage.tokensUsed, 0);
});

test("repeated tool_execution_end events coalesce runtime persistence when usage is unchanged", async () => {
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  try {
    const harness = createRuntimeHarness();
    await harness.runCommand("ship it");
    const goalId = harness.snapshot().goal?.goalId;
    assert.ok(goalId);
    const initialSetEntries = countGoalSetEntries(harness.entries, goalId);
    assert.equal(initialSetEntries, 1);

    await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });

    for (let index = 0; index < 5; index += 1) {
      now += 2_000;
      await emitToolExecutionEnd(harness);
    }

    assert.equal(countGoalSetEntries(harness.entries, goalId), initialSetEntries);
    assert.match(harness.footerStatuses.at(-1) ?? "", /Pursuing goal/);
  } finally {
    Date.now = originalNow;
  }
});

test("tool completion and turn_end durably persist their own deltas", async () => {
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  try {
    const harness = createRuntimeHarness();
    await harness.runCommand("ship it");
    const goalId = harness.snapshot().goal?.goalId;
    assert.ok(goalId);

    await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
    now += 5_000;
    await emitToolExecutionEnd(harness);
    assert.equal(countGoalSetEntries(harness.entries, goalId), 1);

    await harness.emit("turn_end", {
      type: "turn_end",
      turnIndex: 0,
      message: assistantMessage("toolUse", { input: 10, output: 2 }),
      toolResults: [],
    });

    assert.equal(countGoalSetEntries(harness.entries, goalId), 1);
    assert.equal(countGoalUsageEntries(harness.entries, goalId), 2);
    const goal = harness.snapshot().goal;
    assert.equal(goal?.usage.tokensUsed, 12);
    assert.equal(goal?.usage.activeSeconds, 5);
  } finally {
    Date.now = originalNow;
  }
});

test("session_shutdown flushes pending runtime usage", async () => {
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  try {
    const harness = createRuntimeHarness();
    await harness.runCommand("ship it");
    const goalId = harness.snapshot().goal?.goalId;
    assert.ok(goalId);

    await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
    now += 4_000;
    await emitToolExecutionEnd(harness);
    assert.equal(countGoalSetEntries(harness.entries, goalId), 1);

    await harness.emit("session_shutdown", sessionShutdownEvent());

    assert.equal(countGoalSetEntries(harness.entries, goalId), 1);
    assert.equal(countGoalUsageEntries(harness.entries, goalId), 1);
    const goal = harness.snapshot().goal;
    assert.equal(goal?.usage.activeSeconds, 4);
  } finally {
    Date.now = originalNow;
  }
});

test("each elapsed delta is durable before turn_end", async () => {
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  try {
    const harness = createRuntimeHarness();
    await harness.runCommand("ship it");
    const goalId = harness.snapshot().goal?.goalId;
    assert.ok(goalId);
    const initialSetEntries = countGoalSetEntries(harness.entries, goalId);
    assert.equal(initialSetEntries, 1);

    await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });

    now += 61_000;
    await emitToolExecutionEnd(harness);

    assert.equal(countGoalSetEntries(harness.entries, goalId), initialSetEntries);
    assert.equal(countGoalUsageEntries(harness.entries, goalId), 1);
    const afterIntervalFlush = harness.snapshot().goal;
    assert.equal(afterIntervalFlush?.usage.activeSeconds, 61);

    for (let index = 0; index < 3; index += 1) {
      now += 2_000;
      await emitToolExecutionEnd(harness);
    }

    assert.equal(countGoalSetEntries(harness.entries, goalId), initialSetEntries);
    assert.equal(countGoalUsageEntries(harness.entries, goalId), 4);

    await harness.emit("turn_end", {
      type: "turn_end",
      turnIndex: 0,
      message: assistantMessage("toolUse", { input: 10, output: 2 }),
      toolResults: [],
    });

    assert.equal(countGoalSetEntries(harness.entries, goalId), initialSetEntries);
    assert.equal(countGoalUsageEntries(harness.entries, goalId), 5);
    const goal = harness.snapshot().goal;
    assert.equal(goal?.usage.tokensUsed, 12);
    assert.equal(goal?.usage.activeSeconds, 67);
  } finally {
    Date.now = originalNow;
  }
});

test("reconstructGoal uses the latest snapshot across dense legacy and coalesced entries", () => {
  const goal = createThreadGoal("ship it", 100);
  const denseEntries = Array.from({ length: 20 }, (_, index) => ({
    type: "custom" as const,
    customType: CUSTOM_ENTRY_TYPE,
    data: setEntry(
      {
        ...goal,
        usage: { tokensUsed: index + 1, activeSeconds: index },
        updatedAt: goal.updatedAt + index,
      },
      "runtime",
      goal.updatedAt + index,
    ),
  }));
  const coalescedEntry = {
    type: "custom" as const,
    customType: CUSTOM_ENTRY_TYPE,
    data: runtimeUsageEntry(
      {
        ...goal,
        usage: { tokensUsed: 99, activeSeconds: 42 },
        status: "active",
        updatedAt: goal.updatedAt + 100,
      },
      goal.updatedAt + 100,
    ),
  };

  const reconstructed = reconstructGoal([...denseEntries, coalescedEntry]).goal;
  assert.ok(reconstructed);
  assert.equal(reconstructed.usage.tokensUsed, 99);
  assert.equal(reconstructed.usage.activeSeconds, 42);
});

test("compaction with unchanged paused goal appends no new entry", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  await harness.runCommand("pause");
  const goalId = harness.snapshot().goal?.goalId;
  assert.ok(goalId);
  const entryCountAfterPause = harness.entries.length;

  await harness.emit("session_before_compact", sessionBeforeCompactEvent());
  await harness.emit("session_compact", sessionCompactEvent());

  assert.equal(harness.entries.length, entryCountAfterPause);
  assert.equal(harness.snapshot().goal?.status, "paused");
  assert.equal(countGoalSetEntries(harness.entries, goalId), 2);
});

test("compaction with unchanged budgetLimited goal appends no new entry", async () => {
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  try {
    const harness = createRuntimeHarness();
    await harness.runTool("create_goal", { objective: "ship it", token_budget: 10 });
    const goalId = harness.snapshot().goal?.goalId;
    assert.ok(goalId);

    await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
    await harness.emit("turn_end", {
      type: "turn_end",
      turnIndex: 0,
      message: assistantMessage("stop", { input: 8, output: 3 }),
      toolResults: [],
    });

    const goal = harness.snapshot().goal;
    assert.equal(goal?.status, "budgetLimited");
    assert.equal(goal?.usage.tokensUsed, 11);
    const activeSecondsAtBudgetLimit = goal?.usage.activeSeconds ?? 0;
    const entryCountAfterBudgetLimit = harness.entries.length;
    const setEntriesAfterBudgetLimit = countGoalSetEntries(harness.entries, goalId);
    const usageEntriesAfterBudgetLimit = countGoalUsageEntries(harness.entries, goalId);
    assert.equal(setEntriesAfterBudgetLimit, 1);
    assert.equal(usageEntriesAfterBudgetLimit, 1);

    now += 60_000;

    await harness.emit("session_before_compact", sessionBeforeCompactEvent());
    await harness.emit("session_compact", sessionCompactEvent());

    assert.equal(harness.entries.length, entryCountAfterBudgetLimit);
    assert.equal(harness.snapshot().goal?.status, "budgetLimited");
    assert.equal(countGoalSetEntries(harness.entries, goalId), setEntriesAfterBudgetLimit);
    assert.equal(countGoalUsageEntries(harness.entries, goalId), usageEntriesAfterBudgetLimit);
    assert.equal(harness.snapshot().goal?.usage.tokensUsed, 11);
    assert.equal(harness.snapshot().goal?.usage.activeSeconds, activeSecondsAtBudgetLimit);
  } finally {
    Date.now = originalNow;
  }
});

test("session_shutdown with unchanged budgetLimited goal appends no new entry", async () => {
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  try {
    const harness = createRuntimeHarness();
    await harness.runTool("create_goal", { objective: "ship it", token_budget: 10 });
    const goalId = harness.snapshot().goal?.goalId;
    assert.ok(goalId);

    await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
    await harness.emit("turn_end", {
      type: "turn_end",
      turnIndex: 0,
      message: assistantMessage("stop", { input: 8, output: 3 }),
      toolResults: [],
    });

    const goal = harness.snapshot().goal;
    assert.equal(goal?.status, "budgetLimited");
    assert.equal(goal?.usage.tokensUsed, 11);
    const activeSecondsAtBudgetLimit = goal?.usage.activeSeconds ?? 0;
    const entryCountAfterBudgetLimit = harness.entries.length;
    const setEntriesAfterBudgetLimit = countGoalSetEntries(harness.entries, goalId);
    const usageEntriesAfterBudgetLimit = countGoalUsageEntries(harness.entries, goalId);
    assert.equal(setEntriesAfterBudgetLimit, 1);
    assert.equal(usageEntriesAfterBudgetLimit, 1);

    now += 60_000;

    await harness.emit("session_shutdown", sessionShutdownEvent());

    assert.equal(harness.entries.length, entryCountAfterBudgetLimit);
    assert.equal(harness.snapshot().goal?.status, "budgetLimited");
    assert.equal(countGoalSetEntries(harness.entries, goalId), setEntriesAfterBudgetLimit);
    assert.equal(countGoalUsageEntries(harness.entries, goalId), usageEntriesAfterBudgetLimit);
    assert.equal(harness.snapshot().goal?.usage.tokensUsed, 11);
    assert.equal(harness.snapshot().goal?.usage.activeSeconds, activeSecondsAtBudgetLimit);
  } finally {
    Date.now = originalNow;
  }
});

test("get_goal rejects non-empty input", async () => {
  const harness = createRuntimeHarness();

  await assert.rejects(
    () => harness.runTool("get_goal", { unexpected: true }),
    /Unknown goal tool property: unexpected/,
  );
});

test("create_goal rejects malformed token budgets at the tool boundary", async () => {
  for (const token_budget of [
    null,
    0,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    1e100,
    "10",
    Number.NaN,
  ]) {
    const harness = createRuntimeHarness();
    await assert.rejects(
      () => harness.runTool("create_goal", { objective: "ship it", token_budget }),
      /Token budget must be a positive integer/,
    );
    assert.equal(harness.snapshot().goal, null);
  }
});

test("create_goal rejects the removed model-facing replacement option", async () => {
  const harness = createRuntimeHarness();

  await assert.rejects(
    () =>
      harness.runTool("create_goal", {
        objective: "new objective",
        replace_existing: true,
      }),
    /Unknown goal tool property: replace_existing/,
  );
  assert.equal(harness.snapshot().goal, null);
});

test("update_goal accepts only required complete or blocked status", async () => {
  for (const params of [
    {},
    { status: "active" },
    { status: "paused" },
    { status: "usageLimited" },
    { status: "budgetLimited" },
    { status: "complete", objective: "changed" },
    { status: "blocked", token_budget: 10 },
  ]) {
    const harness = createRuntimeHarness();
    await harness.runCommand("ship it");
    await assert.rejects(() => harness.runTool("update_goal", params));
    assert.equal(harness.snapshot().goal?.status, "active");
    assert.equal(harness.snapshot().goal?.objective, "ship it");
    assert.equal(harness.snapshot().goal?.tokenBudget, null);
  }

  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  const result = (await harness.runTool("update_goal", { status: "blocked" })) as {
    details: { goal: { status: string }; completionBudgetReport: string | null };
  };
  assert.equal(result.details.goal.status, "blocked");
  assert.equal(result.details.completionBudgetReport, null);
});

test("create_goal replaces a completed goal", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  const completedGoalId = harness.snapshot().goal?.goalId;
  await harness.runTool("update_goal", { status: "complete" });

  const created = (await harness.runTool("create_goal", { objective: "next objective" })) as {
    details: Record<string, unknown>;
  };

  assert.equal((created.details.goal as { objective?: string }).objective, "next objective");
  assert.equal(harness.snapshot().goal?.status, "active");
  assert.notEqual(harness.snapshot().goal?.goalId, completedGoalId);
});

test("create_goal cannot replace a non-complete goal", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  const originalGoalId = harness.snapshot().goal?.goalId;

  await assert.rejects(
    () => harness.runTool("create_goal", { objective: "replacement" }),
    /already has a non-complete goal/,
  );

  assert.equal(harness.snapshot().goal?.goalId, originalGoalId);
  assert.equal(harness.snapshot().goal?.objective, "ship it");
});

test("failed create_goal throws so pi marks the tool result as an error", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");

  await assert.rejects(
    () => harness.runTool("create_goal", { objective: "duplicate" }),
    /already has a non-complete goal/,
  );
});
