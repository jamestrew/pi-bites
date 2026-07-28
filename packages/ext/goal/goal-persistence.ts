import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  persistClearedForkDeferral,
  persistForkSnapshot as persistDurableForkSnapshot,
  type ForkTransferEntry,
  type RestoredGoalState,
} from "./fork-inheritance.js";
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
  let inheritedTransferId: string | null = null;
  let deferredTransferId: string | null = null;

  const getGoal = (): ThreadGoal | null => (goal ? cloneGoal(goal) : null);
  const hasInheritedForkSnapshot = (): boolean => inheritedTransferId !== null;
  const isContinuationDeferred = (): boolean => deferredTransferId !== null;

  const restore = (restored: RestoredGoalState): void => {
    goal = restored.goal ? cloneGoal(restored.goal) : null;
    inheritedTransferId = restored.inheritedTransferId;
    deferredTransferId = restored.deferredTransferId;
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

  const persistForkSnapshot = (transfer: ForkTransferEntry): boolean => {
    if (inheritedTransferId === transfer.transferId) {
      return false;
    }
    persistDurableForkSnapshot(deps.pi.appendEntry.bind(deps.pi), transfer);
    goal = transfer.goal ? cloneGoal(transfer.goal) : null;
    lastPersistedGoal = transfer.goal ? cloneGoal(transfer.goal) : null;
    inheritedTransferId = transfer.transferId;
    deferredTransferId = transfer.goal ? transfer.transferId : null;
    return true;
  };

  const clearForkDeferral = (): boolean => {
    if (!deferredTransferId) {
      return false;
    }
    persistClearedForkDeferral(deps.pi.appendEntry.bind(deps.pi), deferredTransferId);
    deferredTransferId = null;
    return true;
  };

  return {
    appendClearEntry,
    clearForkDeferral,
    getGoal,
    hasInheritedForkSnapshot,
    isContinuationDeferred,
    persistForkSnapshot,
    persistGoalSnapshot,
    restore,
    syncPersistedSnapshot,
  };
}

export type GoalPersistence = ReturnType<typeof createGoalPersistence>;
