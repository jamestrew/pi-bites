import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  clearEntry,
  cloneGoal,
  goalsEquivalent,
  isRuntimeUsageGoalStatus,
  runtimeUsageEntry,
  setEntry,
} from "./state.js";
import { CUSTOM_ENTRY_TYPE, type GoalEntrySource, type ThreadGoal } from "./types.js";

interface GoalPersistenceDeps {
  pi: Pick<ExtensionAPI, "appendEntry">;
}

function canPersistRuntimeUsageEntry(
  goal: ThreadGoal,
  lastPersistedGoal: ThreadGoal | null,
): boolean {
  return Boolean(
    lastPersistedGoal &&
    goal.goalId === lastPersistedGoal.goalId &&
    goal.objective === lastPersistedGoal.objective &&
    goal.tokenBudget === lastPersistedGoal.tokenBudget &&
    goal.createdAt === lastPersistedGoal.createdAt &&
    isRuntimeUsageGoalStatus(goal.status) &&
    isRuntimeUsageGoalStatus(lastPersistedGoal.status),
  );
}

export function createGoalPersistence(deps: GoalPersistenceDeps) {
  let goal: ThreadGoal | null = null;
  let lastPersistedGoal: ThreadGoal | null = null;

  const getGoal = (): ThreadGoal | null => (goal ? cloneGoal(goal) : null);

  const setGoalSnapshot = (nextGoal: ThreadGoal | null): void => {
    goal = nextGoal ? cloneGoal(nextGoal) : null;
  };

  const syncPersistedSnapshot = (snapshot: ThreadGoal | null): void => {
    lastPersistedGoal = snapshot ? cloneGoal(snapshot) : null;
  };

  const matchesExpectedGoal = (expectedGoalId: string | null): boolean =>
    (goal?.goalId ?? null) === expectedGoalId;

  /** Synchronous by design: no lifecycle event can interleave snapshot, write, and commit. */
  const persistGoalSnapshot = (
    nextGoal: ThreadGoal,
    source: GoalEntrySource,
    expectedGoalId: string | null,
  ): boolean => {
    if (!matchesExpectedGoal(expectedGoalId)) {
      return false;
    }
    if (lastPersistedGoal && goalsEquivalent(nextGoal, lastPersistedGoal)) {
      goal = cloneGoal(nextGoal);
      return true;
    }

    deps.pi.appendEntry(
      CUSTOM_ENTRY_TYPE,
      source === "runtime" && canPersistRuntimeUsageEntry(nextGoal, lastPersistedGoal)
        ? runtimeUsageEntry(nextGoal)
        : setEntry(nextGoal, source),
    );
    // appendEntry is the durable boundary. Never expose the new snapshot before it succeeds.
    goal = cloneGoal(nextGoal);
    lastPersistedGoal = cloneGoal(nextGoal);
    return true;
  };

  const appendClearEntry = (clearedGoalId: string | null, source: GoalEntrySource): boolean => {
    if (!matchesExpectedGoal(clearedGoalId)) {
      return false;
    }
    deps.pi.appendEntry(CUSTOM_ENTRY_TYPE, clearEntry(clearedGoalId, source));
    goal = null;
    lastPersistedGoal = null;
    return true;
  };

  return {
    appendClearEntry,
    getGoal,
    persistGoalSnapshot,
    setGoalSnapshot,
    syncPersistedSnapshot,
  };
}

export type GoalPersistence = ReturnType<typeof createGoalPersistence>;
