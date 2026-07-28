import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { persistForkTransfer, type ForkTransferEntry } from "./fork-inheritance.js";
import type { GoalPersistence } from "./goal-persistence.js";
import type { StatusContext } from "./goal-runtime-status.js";
import {
  applyGoalTransitionEffects,
  planGoalTransition,
  reloadGoalRuntimeEffects,
  type GoalTransitionEffectHandlers,
  type GoalTransitionRequest,
} from "./goal-transition.js";
import {
  applyHostOverflowUserResetPersistence,
  beginHostOverflowRecovery,
  requireHostOverflowUserReset,
  syncHostOverflowUserResetFromSession,
  type GoalRecoveryMachineState,
} from "./recovery-machine.js";
import {
  goalsEquivalent,
  hostOverflowCapResetEntry,
  reconstructGoal,
  reconstructHostOverflowCapNeedsUserReset,
  updateGoalStatus,
} from "./state.js";
import {
  CUSTOM_ENTRY_TYPE,
  type GoalEntrySource,
  type GoalResult,
  type ThreadGoal,
} from "./types.js";

interface GoalStateControllerDeps {
  pi: Pick<ExtensionAPI, "appendEntry">;
  persistence: GoalPersistence;
  getRecoveryState: () => GoalRecoveryMachineState;
  transitionEffectHandlers: GoalTransitionEffectHandlers;
  refreshUi: (ctx: StatusContext) => void;
}

export interface GoalStateController {
  applyGoalTransition: (request: GoalTransitionRequest, ctx: StatusContext | null) => boolean;
  beginOverflowRecovery: (ctx: StatusContext) => void;
  updateGoal: (
    status: "active" | "paused" | "complete" | "blocked" | "usageLimited",
    source: GoalEntrySource,
    ctx: StatusContext,
    expectedGoalId?: string | null,
  ) => GoalResult;
  getGoal: () => ThreadGoal | null;
  hasInheritedForkSnapshot: () => boolean;
  isContinuationDeferred: () => boolean;
  isCurrentActiveGoalId: (goalId: string) => boolean;
  prepareForkTransfer: (
    sourceSessionId: string,
    entryId: string,
    position: "before" | "at",
    targetLeafId: string | null,
    sessionFile: string | undefined,
    destinationHasPersistenceBoundary: boolean,
  ) => ForkTransferEntry;
  inheritForkSnapshot: (transfer: ForkTransferEntry, ctx: ExtensionContext) => boolean;
  clearForkDeferral: (ctx: ExtensionContext) => boolean;
  persistHostOverflowUserReset: (needsReset: boolean) => void;
  reloadFromSession: (ctx: ExtensionContext) => void;
}

export function createGoalStateController(deps: GoalStateControllerDeps) {
  const getGoal = (): ThreadGoal | null => deps.persistence.getGoal();

  const isCurrentActiveGoalId = (goalId: string): boolean => {
    const goal = getGoal();
    return goal?.goalId === goalId && goal.status === "active";
  };

  const applyGoalTransition = (
    request: GoalTransitionRequest,
    ctx: StatusContext | null,
  ): boolean => {
    const current = getGoal();
    if (request.kind === "runtime_accounting" && current?.goalId !== request.nextGoal.goalId) {
      return false;
    }
    const plan = planGoalTransition(current, request);

    if (plan.persist === "skip") {
      applyGoalTransitionEffects(plan.afterPersist, deps.transitionEffectHandlers);
      if (ctx) {
        deps.refreshUi(ctx);
      }
      return false;
    }

    const expectedGoalId = current?.goalId ?? null;
    const persisted =
      plan.persist === "clear"
        ? deps.persistence.appendClearEntry(expectedGoalId, plan.source)
        : deps.persistence.persistGoalSnapshot(plan.nextGoal, plan.source, expectedGoalId);
    if (!persisted) {
      return false;
    }

    // Memory effects happen only after the durable write commits.
    applyGoalTransitionEffects(plan.beforePersist, deps.transitionEffectHandlers);
    applyGoalTransitionEffects(plan.afterPersist, deps.transitionEffectHandlers);
    if (ctx) {
      deps.refreshUi(ctx);
    }
    return true;
  };

  const persistHostOverflowUserReset = (needsReset: boolean): void => {
    if (!applyHostOverflowUserResetPersistence(deps.getRecoveryState(), needsReset)) {
      return;
    }
    deps.pi.appendEntry(CUSTOM_ENTRY_TYPE, hostOverflowCapResetEntry(needsReset));
  };

  const beginOverflowRecovery = (ctx: StatusContext): void => {
    const goal = getGoal();
    const hasActiveGoal = Boolean(goal && goal.status === "active");
    let shouldPersist: boolean;

    if (hasActiveGoal) {
      applyGoalTransitionEffects([{ type: "clearContinuation" }], deps.transitionEffectHandlers);
      const { persistHostOverflowCapReset } = beginHostOverflowRecovery(deps.getRecoveryState());
      shouldPersist = persistHostOverflowCapReset;
      deps.refreshUi(ctx);
    } else {
      shouldPersist = requireHostOverflowUserReset(deps.getRecoveryState());
    }

    if (shouldPersist) {
      deps.pi.appendEntry(CUSTOM_ENTRY_TYPE, hostOverflowCapResetEntry(true));
    }
  };

  const reloadFromSession = (ctx: ExtensionContext): void => {
    const previousGoalId = getGoal()?.goalId ?? null;
    const branch = ctx.sessionManager.getBranch();
    const reconstructed = reconstructGoal(branch);
    deps.persistence.restore(reconstructed);
    deps.persistence.syncPersistedSnapshot(reconstructed.goal);
    syncHostOverflowUserResetFromSession(
      deps.getRecoveryState(),
      reconstructHostOverflowCapNeedsUserReset(branch),
    );
    applyGoalTransitionEffects(
      reloadGoalRuntimeEffects(previousGoalId, reconstructed.goal),
      deps.transitionEffectHandlers,
    );
    deps.refreshUi(ctx);
  };

  const prepareForkTransfer = (
    sourceSessionId: string,
    entryId: string,
    position: "before" | "at",
    targetLeafId: string | null,
    sessionFile: string | undefined,
    destinationHasPersistenceBoundary: boolean,
  ): ForkTransferEntry => {
    const goal = getGoal();
    return persistForkTransfer(deps.pi.appendEntry.bind(deps.pi), sessionFile, {
      sourceSessionId,
      entryId,
      position,
      targetLeafId,
      goal,
      destinationHasPersistenceBoundary,
    });
  };

  const inheritForkSnapshot = (transfer: ForkTransferEntry, ctx: ExtensionContext): boolean => {
    const previousGoalId = getGoal()?.goalId ?? null;
    if (!deps.persistence.persistForkSnapshot(transfer)) {
      return false;
    }
    applyGoalTransitionEffects(
      reloadGoalRuntimeEffects(previousGoalId, transfer.goal),
      deps.transitionEffectHandlers,
    );
    deps.refreshUi(ctx);
    return true;
  };

  const clearForkDeferral = (ctx: ExtensionContext): boolean => {
    if (!deps.persistence.clearForkDeferral()) {
      return false;
    }
    deps.refreshUi(ctx);
    return true;
  };

  const updateGoal = (
    status: "active" | "paused" | "complete" | "blocked" | "usageLimited",
    source: GoalEntrySource,
    ctx: StatusContext,
    expectedGoalId?: string | null,
  ): GoalResult => {
    const goal = getGoal();
    if (expectedGoalId !== undefined && goal?.goalId !== expectedGoalId) {
      return { ok: false, message: "Goal changed before status update.", goal };
    }
    const result = updateGoalStatus(goal, status);
    if (!result.ok || !result.goal) {
      return result;
    }
    if (goal && goalsEquivalent(goal, result.goal)) {
      return result;
    }
    applyGoalTransition({ kind: "set", nextGoal: result.goal, source }, ctx);
    return result;
  };

  const controller: GoalStateController = {
    applyGoalTransition,
    beginOverflowRecovery,
    updateGoal,
    getGoal,
    hasInheritedForkSnapshot: deps.persistence.hasInheritedForkSnapshot,
    isContinuationDeferred: deps.persistence.isContinuationDeferred,
    isCurrentActiveGoalId,
    prepareForkTransfer,
    inheritForkSnapshot,
    clearForkDeferral,
    persistHostOverflowUserReset,
    reloadFromSession,
  };

  return controller;
}
