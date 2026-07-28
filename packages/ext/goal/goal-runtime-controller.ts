import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { registerGoalCommand } from "./commands.js";
import { createContinuationScheduler } from "./continuation-scheduler.js";
import { createGoalAccounting } from "./goal-accounting.js";
import { createGoalPersistence } from "./goal-persistence.js";
import {
  createGoalRuntimeEventHandlers,
  type GoalRuntimeEventHandlers,
} from "./goal-runtime-event-handlers.js";
import { registerGoalRuntimeEvents } from "./goal-runtime-events.js";
import { createGoalRuntimeState } from "./goal-runtime-state.js";
import { createGoalRuntimeStatus, type StatusContext } from "./goal-runtime-status.js";
import { createGoalStateController, type GoalStateController } from "./goal-state-controller.js";
import { continuationPrompt } from "./prompts.js";
import { createGoalRecoveryRuntime } from "./recovery-runtime.js";
import {
  goalStartTurnStrategy,
  resetRecoveryMachine,
  type GoalStartTurnStrategy,
} from "./recovery-machine.js";
import { goalWithLiveUsage } from "./state.js";
import { registerGoalTools } from "./tools.js";
import type { GoalEntrySource, GoalResult, ThreadGoal } from "./types.js";

export interface GoalRuntimeController extends GoalRuntimeEventHandlers {
  getGoalForDisplay(): ThreadGoal | null;
  getGoalStartTurnStrategy(): GoalStartTurnStrategy;
  setGoal(goal: ThreadGoal, source: GoalEntrySource, ctx: ExtensionContext): void;
  clearGoal(source: GoalEntrySource, ctx: ExtensionContext): void;
  pauseGoal(goalId: string, source: GoalEntrySource, ctx: ExtensionContext): GoalResult;
  updateGoal(
    status: "complete" | "blocked",
    source: GoalEntrySource,
    ctx: ExtensionContext,
  ): GoalResult;
  resumeGoalWithContinuation(
    goalId: string,
    source: GoalEntrySource,
    ctx: StatusContext,
  ): GoalResult;
}

export interface GoalRuntimeOptions {
  monotonicNow?: () => number;
}

export function createGoalRuntimeController(
  pi: ExtensionAPI,
  options: GoalRuntimeOptions = {},
): GoalRuntimeController {
  const runtimeState = createGoalRuntimeState();
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const persistence = createGoalPersistence({ pi });

  const resetErrorRecovery = (): void => {
    resetRecoveryMachine(runtimeState.recoveryState);
  };

  const goalForDisplay = () =>
    goalWithLiveUsage(
      persistence.getGoal(),
      runtimeState.accounting.activeGoalId,
      runtimeState.accounting.lastAccountedAt,
      monotonicNow(),
      runtimeState.accounting.elapsedCarryMs,
    );

  const status = createGoalRuntimeStatus({
    getGoalForDisplay: goalForDisplay,
    getGoalStatus: () => persistence.getGoal()?.status ?? null,
    isOverflowPending: () => runtimeState.recoveryState.overflowPending,
  });

  const continuation = createContinuationScheduler({
    pi,
    getGoal: () => persistence.getGoal(),
    isContinuationDeferred: persistence.isContinuationDeferred,
    getRecoveryState: () => runtimeState.recoveryState,
    staleQueuedWorkGuard: runtimeState.staleQueuedWorkGuard,
    getCurrentTurnIndex: () => runtimeState.currentTurnIndex,
    getAgentRunSequence: () => runtimeState.agentRunSequence,
  });

  let stateController: GoalStateController;
  const goalAccounting = createGoalAccounting(
    {
      getGoal: () => stateController.getGoal(),
      getAccounting: () => runtimeState.accounting,
      applyRuntimeAccountingTransition(ctx, nextGoal) {
        return stateController.applyGoalTransition({ kind: "runtime_accounting", nextGoal }, ctx);
      },
      sendMessage: pi.sendMessage.bind(pi),
    },
    { monotonicNow },
  );

  stateController = createGoalStateController({
    pi,
    persistence,
    getRecoveryState: () => runtimeState.recoveryState,
    transitionEffectHandlers: {
      clearContinuation: continuation.clearContinuationState,
      clearActiveAccounting: (preserveCarry) => goalAccounting.detach({ preserveCarry }),
      resetRecovery: resetErrorRecovery,
      clearBudgetWarning: () => {
        runtimeState.accounting.budgetWarningSentFor = null;
      },
      markContinuationQueued: continuation.markContinuationQueued,
      stopStatusRefresh: () => status.stopStatusRefresh(),
    },
    refreshUi: (ctx) => status.refreshUi(ctx),
  });

  const recoveryRuntime = createGoalRecoveryRuntime({
    getGoal: () => stateController.getGoal(),
    getRecoveryState: () => runtimeState.recoveryState,
    blockGoalForOverflow(ctx) {
      stateController.updateGoal("blocked", "runtime", ctx);
    },
    refreshUi: status.refreshUi,
    maybeContinue: continuation.maybeContinue,
  });

  const resumeGoalWithContinuation = (
    goalId: string,
    source: GoalEntrySource,
    ctx: StatusContext,
  ): GoalResult => {
    goalAccounting.accountProgress(ctx, false, true);
    const resumedFromBlocked = stateController.getGoal()?.status === "blocked";
    const result = stateController.updateGoal("active", source, ctx, goalId);
    if (!result.ok || !result.goal || result.goal.status !== "active") {
      return result;
    }
    goalAccounting.beginAccounting();
    pi.sendUserMessage(continuationPrompt(result.goal, { freshBlockedAudit: resumedFromBlocked }), {
      deliverAs: "followUp",
    });
    return result;
  };

  const eventHandlers = createGoalRuntimeEventHandlers({
    pi,
    runtimeState,
    stateController,
    continuation,
    goalAccounting,
    recoveryRuntime,
    status,
    clearActiveAccounting: goalAccounting.detach,
    resetErrorRecovery,
    resumeGoalWithContinuation,
  });

  const applyAccountedGoalMutation = <T>(ctx: ExtensionContext, mutate: () => T): T => {
    goalAccounting.accountProgress(ctx, false, true);
    return mutate();
  };

  const updateGoal = (
    goalStatus: "complete" | "blocked",
    source: GoalEntrySource,
    ctx: ExtensionContext,
  ): GoalResult => {
    const expectedGoalId = runtimeState.accounting.turnInProgress
      ? runtimeState.accounting.turnGoalId
      : stateController.getGoal()?.goalId;
    return applyAccountedGoalMutation(ctx, () =>
      stateController.updateGoal(goalStatus, source, ctx, expectedGoalId),
    );
  };

  return {
    getGoalForDisplay: goalForDisplay,
    getGoalStartTurnStrategy: () => goalStartTurnStrategy(runtimeState.recoveryState.phase),
    setGoal(nextGoal, source, ctx) {
      const adoptForCurrentTurn = stateController.getGoal() === null;
      applyAccountedGoalMutation(ctx, () =>
        stateController.applyGoalTransition({ kind: "set", nextGoal, source }, ctx),
      );
      goalAccounting.beginAccounting(adoptForCurrentTurn);
    },
    clearGoal(source, ctx) {
      applyAccountedGoalMutation(ctx, () =>
        stateController.applyGoalTransition({ kind: "clear", source }, ctx),
      );
    },
    pauseGoal(goalId, source, ctx) {
      return applyAccountedGoalMutation(ctx, () =>
        stateController.updateGoal("paused", source, ctx, goalId),
      );
    },
    updateGoal,
    resumeGoalWithContinuation,
    ...eventHandlers,
  };
}

export function registerGoalRuntimeController(
  pi: ExtensionAPI,
  options: GoalRuntimeOptions = {},
): void {
  const controller = createGoalRuntimeController(pi, options);
  registerGoalTools(pi, {
    getGoal: () => controller.getGoalForDisplay(),
    setGoal: controller.setGoal.bind(controller),
    updateGoal: controller.updateGoal.bind(controller),
  });
  registerGoalCommand(pi, {
    getGoal: () => controller.getGoalForDisplay(),
    getGoalStartTurnStrategy: controller.getGoalStartTurnStrategy.bind(controller),
    setGoal: controller.setGoal.bind(controller),
    clearGoal: controller.clearGoal.bind(controller),
    pauseGoal: controller.pauseGoal.bind(controller),
    resumeGoalWithContinuation: controller.resumeGoalWithContinuation.bind(controller),
  });
  registerGoalRuntimeEvents(pi, controller);
}
