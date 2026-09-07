import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";

import { createRuntimeHarness, flushContinuationScheduler } from "./support/runtime-harness.js";

afterEach(() => {
  vi.useRealTimers();
});

async function prepareTreeNavigation(harness: ReturnType<typeof createRuntimeHarness>) {
  await harness.emit("session_before_tree", {
    type: "session_before_tree",
    preparation: {},
    signal: new AbortController().signal,
  });
}

async function displayedGoal(harness: ReturnType<typeof createRuntimeHarness>) {
  const result = (await harness.runTool("get_goal", {})) as {
    details: {
      goal: {
        objective: string;
        status: string;
        timeUsedSeconds: number;
        createdAt: number;
        updatedAt: number;
      } | null;
    };
  };
  return result.details.goal;
}

test("tree navigation reconstructs and mutates only the selected sibling branch", async () => {
  vi.useFakeTimers();
  const harness = createRuntimeHarness();

  await harness.runCommand("branch A");
  const branchA = harness.entries.map((entry) => entry.id);
  harness.sentMessages.length = 0;

  await prepareTreeNavigation(harness);
  harness.selectBranch([]);
  await harness.emit("session_tree", { type: "session_tree" });
  assert.equal(await displayedGoal(harness), null);
  vi.runOnlyPendingTimers();
  assert.equal(harness.sentMessages.length, 0);

  await harness.runCommand("branch B");
  const branchB = harness.entries.slice(branchA.length).map((entry) => entry.id);
  assert.equal((await displayedGoal(harness))?.objective, "branch B");

  harness.sentMessages.length = 0;
  await prepareTreeNavigation(harness);
  harness.selectBranch(branchA);
  await harness.emit("session_tree", { type: "session_tree" });
  assert.equal((await displayedGoal(harness))?.objective, "branch A");
  assert.equal(harness.sentMessages.length, 0);
  vi.runOnlyPendingTimers();
  assert.equal(harness.sentMessages.length, 1);

  await harness.runTool("update_goal", { status: "complete" });
  assert.equal((await displayedGoal(harness))?.status, "complete");
  const completionEntry = harness.entries.at(-1);
  assert.ok(completionEntry);
  const completedBranchA = [...branchA, completionEntry.id];

  await prepareTreeNavigation(harness);
  harness.selectBranch(branchB);
  await harness.emit("session_tree", { type: "session_tree" });
  assert.deepEqual(await displayedGoal(harness), {
    threadId: "session",
    objective: "branch B",
    status: "active",
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: (await displayedGoal(harness))?.createdAt,
    updatedAt: (await displayedGoal(harness))?.updatedAt,
  });

  harness.sentMessages.length = 0;
  await prepareTreeNavigation(harness);
  harness.selectBranch(completedBranchA);
  await harness.emit("session_tree", { type: "session_tree" });
  vi.runOnlyPendingTimers();
  assert.equal((await displayedGoal(harness))?.status, "complete");
  assert.equal(harness.sentMessages.length, 0);
});

test("cancelled tree navigation leaves the current branch runtime intact", async () => {
  let now = 0;
  const harness = createRuntimeHarness({ monotonicNow: () => now });
  await harness.runCommand("stay here");

  await prepareTreeNavigation(harness);
  now = 1_000;
  await harness.emit("tool_execution_end", {
    type: "tool_execution_end",
    toolCallId: "still-current",
    toolName: "bash",
    args: {},
    result: {},
    isError: false,
  });

  assert.equal((await displayedGoal(harness))?.objective, "stay here");
  assert.equal((await displayedGoal(harness))?.timeUsedSeconds, 1);
});

test("repeated tree events settle on one continuation", async () => {
  vi.useFakeTimers();
  const harness = createRuntimeHarness();
  await harness.runCommand("keep going");
  harness.sentMessages.length = 0;

  await prepareTreeNavigation(harness);
  await harness.emit("session_tree", { type: "session_tree" });
  await harness.emit("session_tree", { type: "session_tree" });

  assert.equal(harness.sentMessages.length, 0);
  vi.runOnlyPendingTimers();
  assert.equal(harness.sentMessages.length, 1);
});

test("navigation resets accounting and ignores the previous branch terminal work", async () => {
  vi.useFakeTimers();
  let now = 0;
  const harness = createRuntimeHarness({ monotonicNow: () => now });
  await harness.runCommand("shared goal");
  const branchAtCreation = harness.entries.map((entry) => entry.id);
  const oldContinuation = harness.sentMessages[0];
  assert.ok(oldContinuation);

  await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
  now = 1_500;
  await harness.emit("tool_execution_end", {
    type: "tool_execution_end",
    toolCallId: "old",
    toolName: "bash",
    args: {},
    result: {},
    isError: false,
  });

  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [{ role: "assistant", stopReason: "error", errorMessage: "old failure" }],
  });
  vi.runOnlyPendingTimers();

  harness.selectBranch(branchAtCreation);
  harness.sentMessages.length = 0;
  await harness.emit("session_tree", { type: "session_tree" });
  now = 2_000;
  await harness.emit("tool_execution_end", {
    type: "tool_execution_end",
    toolCallId: "selected",
    toolName: "bash",
    args: {},
    result: {},
    isError: false,
  });

  assert.equal((await displayedGoal(harness))?.status, "active");
  assert.equal((await displayedGoal(harness))?.timeUsedSeconds, 0);
  flushContinuationScheduler();
  assert.equal(harness.sentMessages.length, 1);
});
