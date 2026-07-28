import assert from "node:assert/strict";
import { test } from "vitest";

import {
  applyGoalTransitionEffects,
  planGoalTransition,
  reloadGoalRuntimeEffects,
  type GoalTransitionEffect,
  type GoalTransitionPlan,
} from "../goal-transition.js";
import { cloneGoal, createThreadGoal } from "../state.js";
import type { GoalStatus, ThreadGoal } from "../types.js";

function effectTypes(effects: readonly GoalTransitionEffect[]): string[] {
  return effects.map((effect) => effect.type);
}

function assertNoDuplicateEffectTypes(
  effects: readonly GoalTransitionEffect[],
  label: string,
): void {
  const seen = new Set<string>();
  for (const effect of effects) {
    assert.equal(seen.has(effect.type), false, `${label}: duplicate effect type ${effect.type}`);
    seen.add(effect.type);
  }
}

function assertDisjointPrimitivePlan(plan: GoalTransitionPlan, label: string): void {
  assertNoDuplicateEffectTypes(plan.beforePersist, `${label} beforePersist`);
  assertNoDuplicateEffectTypes(plan.afterPersist, `${label} afterPersist`);
  assertNoDuplicateEffectTypes([...plan.beforePersist, ...plan.afterPersist], `${label} combined`);
}

type CommandSetTableCase = {
  label: string;
  build: () => { current: ThreadGoal; next: ThreadGoal };
  persist: GoalTransitionPlan["persist"];
  before: string[];
  after: string[];
};

const commandSetTable: CommandSetTableCase[] = [
  {
    label: "active skip unchanged",
    build: () => {
      const goal = createThreadGoal("ship it");
      return { current: goal, next: goal };
    },
    persist: "skip",
    before: [],
    after: ["markContinuationQueued"],
  },
  {
    label: "paused skip unchanged",
    build: () => {
      const goal = createThreadGoal("ship it");
      const paused = { ...cloneGoal(goal), status: "paused" as const };
      return { current: paused, next: paused };
    },
    persist: "skip",
    before: [],
    after: [],
  },
  {
    label: "active to same paused",
    build: () => {
      const goal = createThreadGoal("ship it");
      const paused = { ...cloneGoal(goal), status: "paused" as const };
      return { current: goal, next: paused };
    },
    persist: "set",
    before: ["clearContinuation", "clearActiveAccounting", "resetRecovery", "clearBudgetWarning"],
    after: [],
  },
  {
    label: "active to different paused",
    build: () => {
      const current = createThreadGoal("old objective");
      const next = { ...createThreadGoal("new objective"), status: "paused" as const };
      return { current, next };
    },
    persist: "set",
    before: ["clearContinuation", "clearActiveAccounting", "resetRecovery", "clearBudgetWarning"],
    after: [],
  },
  {
    label: "paused to same active",
    build: () => {
      const goal = createThreadGoal("ship it");
      const paused = { ...cloneGoal(goal), status: "paused" as const };
      const active = { ...cloneGoal(goal), status: "active" as const };
      return { current: paused, next: active };
    },
    persist: "set",
    before: ["clearContinuation", "resetRecovery", "clearBudgetWarning"],
    after: ["markContinuationQueued"],
  },
];

for (const tableCase of commandSetTable) {
  test(`planGoalTransition command set table: ${tableCase.label}`, () => {
    const { current, next } = tableCase.build();
    const plan = planGoalTransition(current, {
      kind: "set",
      nextGoal: next,
      source: "command",
    });

    assertDisjointPrimitivePlan(plan, tableCase.label);
    assert.equal(plan.persist, tableCase.persist);
    assert.deepEqual(effectTypes(plan.beforePersist), tableCase.before);
    assert.deepEqual(effectTypes(plan.afterPersist), tableCase.after);
  });
}

test("reloadGoalRuntimeEffects keeps same active goal memory", () => {
  const goal = createThreadGoal("ship it");

  assert.deepEqual(effectTypes(reloadGoalRuntimeEffects(goal.goalId, goal)), ["clearContinuation"]);
});

test("reloadGoalRuntimeEffects clears active accounting for non-active reconstructed goal", () => {
  const goal = { ...createThreadGoal("ship it"), status: "paused" as const };

  assert.deepEqual(effectTypes(reloadGoalRuntimeEffects(goal.goalId, goal)), [
    "clearContinuation",
    "clearActiveAccounting",
  ]);
});

test("reloadGoalRuntimeEffects resets recovery when reconstructed goal id changes", () => {
  const goal = createThreadGoal("ship it");

  assert.deepEqual(effectTypes(reloadGoalRuntimeEffects("previous-goal", goal)), [
    "clearContinuation",
    "resetRecovery",
  ]);
});

test("planGoalTransition clear persists clear with full memory reset", () => {
  const goal = createThreadGoal("ship it");
  const plan = planGoalTransition(goal, { kind: "clear", source: "command" });

  assertDisjointPrimitivePlan(plan, "clear");
  assert.equal(plan.persist, "clear");
  assert.equal(plan.nextGoal, null);
  assert.deepEqual(effectTypes(plan.beforePersist), [
    "clearContinuation",
    "clearActiveAccounting",
    "resetRecovery",
    "clearBudgetWarning",
  ]);
  assert.deepEqual(effectTypes(plan.afterPersist), ["stopStatusRefresh"]);
});

test("planGoalTransition persists every runtime accounting update", () => {
  const goal = createThreadGoal("ship it");
  const next = {
    ...cloneGoal(goal),
    usage: { tokensUsed: 5, activeSeconds: 3 },
    updatedAt: goal.updatedAt + 1,
  };

  const plan = planGoalTransition(goal, {
    kind: "runtime_accounting",
    nextGoal: next,
  });

  assertDisjointPrimitivePlan(plan, "runtime set");
  assert.equal(plan.persist, "set");
  assert.deepEqual(effectTypes(plan.beforePersist), ["clearBudgetWarning"]);
  assert.deepEqual(plan.afterPersist, []);
});

test("planGoalTransition runtime accounting persists immediately when budget is crossed", () => {
  const goal = createThreadGoal("ship it", 10);
  const limited = {
    ...cloneGoal(goal),
    status: "budgetLimited" as const,
    usage: { tokensUsed: 10, activeSeconds: 1 },
    updatedAt: goal.updatedAt + 1,
  };

  const plan = planGoalTransition(goal, {
    kind: "runtime_accounting",
    nextGoal: limited,
  });

  assertDisjointPrimitivePlan(plan, "runtime budget cross");
  assert.equal(plan.persist, "set");
  assert.deepEqual(effectTypes(plan.beforePersist), [
    "clearContinuation",
    "clearActiveAccounting",
    "resetRecovery",
  ]);
});

function runtimeRequest(nextGoal: ThreadGoal) {
  return { kind: "runtime_accounting" as const, nextGoal };
}

test("runtime_accounting rejects null current", () => {
  const next = createThreadGoal("ship it", 10);
  assert.throws(
    () => planGoalTransition(null, runtimeRequest(next)),
    /Invalid runtime_accounting transition: current goal is required/,
  );
});

test("runtime_accounting rejects different goal id", () => {
  const current = createThreadGoal("current", 10);
  const next = createThreadGoal("next", 10);
  assert.throws(
    () => planGoalTransition(current, runtimeRequest(next)),
    /Invalid runtime_accounting transition: goalId mismatch/,
  );
});

test("runtime_accounting rejects unchanged payload", () => {
  const goal = createThreadGoal("ship it", 10);
  assert.throws(
    () => planGoalTransition(goal, runtimeRequest(goal)),
    /runtime accounting must increase usage or change status/,
  );
});

test("runtime_accounting rejects timestamp-only payload", () => {
  const goal = createThreadGoal("ship it", 10);
  const next = { ...cloneGoal(goal), updatedAt: goal.updatedAt + 1 };
  assert.throws(
    () => planGoalTransition(goal, runtimeRequest(next)),
    /runtime accounting must increase usage or change status/,
  );
});

test("runtime_accounting rejects objective mutation", () => {
  const current = createThreadGoal("ship it", 10);
  const next = {
    ...cloneGoal(current),
    objective: "mutated",
    usage: { tokensUsed: 1, activeSeconds: 0 },
    updatedAt: current.updatedAt + 1,
  };
  assert.throws(
    () => planGoalTransition(current, runtimeRequest(next)),
    /objective must be unchanged/,
  );
});

test("runtime_accounting rejects tokenBudget mutation", () => {
  const current = createThreadGoal("ship it", 10);
  const next = {
    ...cloneGoal(current),
    tokenBudget: 99,
    usage: { tokensUsed: 1, activeSeconds: 0 },
    updatedAt: current.updatedAt + 1,
  };
  assert.throws(
    () => planGoalTransition(current, runtimeRequest(next)),
    /tokenBudget must be unchanged/,
  );
});

test("runtime_accounting rejects createdAt mutation", () => {
  const current = createThreadGoal("ship it", 10);
  const next = {
    ...cloneGoal(current),
    createdAt: current.createdAt + 1,
    usage: { tokensUsed: 1, activeSeconds: 0 },
    updatedAt: current.updatedAt + 1,
  };
  assert.throws(
    () => planGoalTransition(current, runtimeRequest(next)),
    /createdAt must be unchanged/,
  );
});

test("runtime_accounting rejects updatedAt rewind", () => {
  const current = createThreadGoal("ship it", 10);
  const next = {
    ...cloneGoal(current),
    usage: { tokensUsed: 1, activeSeconds: 0 },
    updatedAt: current.updatedAt - 1,
  };
  assert.throws(
    () => planGoalTransition(current, runtimeRequest(next)),
    /updatedAt must not decrease/,
  );
});

test("runtime_accounting rejects usage decrease", () => {
  const current = {
    ...createThreadGoal("ship it", 10),
    usage: { tokensUsed: 5, activeSeconds: 2 },
  };
  const next = {
    ...cloneGoal(current),
    usage: { tokensUsed: 4, activeSeconds: 2 },
    updatedAt: current.updatedAt + 1,
  };

  assert.throws(
    () => planGoalTransition(current, runtimeRequest(next)),
    /usage\.tokensUsed must not decrease/,
  );
});

test("runtime_accounting rejects under-budget budgetLimited next", () => {
  const current = createThreadGoal("ship it", 10);
  const next = {
    ...cloneGoal(current),
    status: "budgetLimited" as const,
    usage: { tokensUsed: 5, activeSeconds: 0 },
    updatedAt: current.updatedAt + 1,
  };

  assert.throws(
    () => planGoalTransition(current, runtimeRequest(next)),
    /usage\.tokensUsed must be at or above tokenBudget/,
  );
});

test("runtime_accounting rejects budgetLimited to active", () => {
  const current = {
    ...createThreadGoal("ship it", 10),
    status: "budgetLimited" as const,
    usage: { tokensUsed: 10, activeSeconds: 0 },
  };
  const next = {
    ...cloneGoal(current),
    status: "active" as const,
    usage: { tokensUsed: 11, activeSeconds: 0 },
    updatedAt: current.updatedAt + 1,
  };

  assert.throws(
    () => planGoalTransition(current, runtimeRequest(next)),
    /budgetLimited goals cannot transition to active/,
  );
});

test("runtime_accounting rejects inactive current statuses", () => {
  for (const status of ["paused", "complete"] satisfies GoalStatus[]) {
    const current = { ...createThreadGoal("ship it", 10), status };
    const next = {
      ...cloneGoal(current),
      status: "active" as const,
      usage: { tokensUsed: 1, activeSeconds: 0 },
      updatedAt: current.updatedAt + 1,
    };

    assert.throws(
      () => planGoalTransition(current, runtimeRequest(next)),
      /current status must be active or budgetLimited/,
    );
  }
});

test("runtime_accounting rejects paused or complete next status", () => {
  const current = createThreadGoal("ship it", 10);
  for (const status of ["paused", "complete"] satisfies GoalStatus[]) {
    const next = {
      ...cloneGoal(current),
      status,
      usage: { tokensUsed: 1, activeSeconds: 0 },
      updatedAt: current.updatedAt + 1,
    };

    assert.throws(
      () => planGoalTransition(current, runtimeRequest(next)),
      /next status must be active or budgetLimited/,
    );
  }
});

test("applyGoalTransitionEffects invokes handlers in effect order", () => {
  const calls: string[] = [];
  applyGoalTransitionEffects(
    [
      { type: "clearContinuation" },
      { type: "clearActiveAccounting", preserveCarry: false },
      { type: "resetRecovery" },
      { type: "clearBudgetWarning" },
    ],
    {
      clearContinuation: () => {
        calls.push("clearContinuation");
      },
      clearActiveAccounting: () => {
        calls.push("clearActiveAccounting");
      },
      resetRecovery: () => {
        calls.push("resetRecovery");
      },
      clearBudgetWarning: () => {
        calls.push("clearBudgetWarning");
      },
      markContinuationQueued: (goalId) => {
        calls.push(`markContinuationQueued:${goalId}`);
      },
      stopStatusRefresh: () => {
        calls.push("stopStatusRefresh");
      },
    },
  );

  assert.deepEqual(calls, [
    "clearContinuation",
    "clearActiveAccounting",
    "resetRecovery",
    "clearBudgetWarning",
  ]);
});
