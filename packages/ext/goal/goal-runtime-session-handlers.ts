import type {
  ExtensionContext,
  ExtensionHandler,
  SessionBeforeCompactEvent,
  SessionBeforeForkEvent,
  SessionCompactEvent,
  SessionShutdownEvent,
  SessionStartEvent,
  SessionTreeEvent,
} from "@earendil-works/pi-coding-agent";

import {
  clearActiveHostOverflowRecovery,
  recoveryPhaseBlocksContinuation,
} from "./recovery-machine.js";
import { applyStaleQueuedWorkEffects, runStaleQueuedWorkPlan } from "./goal-runtime-event-utils.js";
import type { GoalRuntimeSessionHandlerContext } from "./goal-runtime-event-handler-types.js";

export function createSessionEventHandlers(deps: GoalRuntimeSessionHandlerContext) {
  const {
    runtimeState,
    stateController,
    continuation,
    goalAccounting,
    recoveryRuntime,
    status,
    resetErrorRecovery,
    resumeGoalWithContinuation,
  } = deps;

  const schedulePostCompactContinuationFallback = (
    ctx: ExtensionContext,
    options: { clearHostOverflowRecovery: boolean },
  ): void => {
    const fallbackOptions = {
      turnIndex: runtimeState.currentTurnIndex,
      agentRunSequence: runtimeState.agentRunSequence,
    };
    continuation.maybeContinueAfterPostCompactFallback(
      ctx,
      options.clearHostOverflowRecovery
        ? {
            ...fallbackOptions,
            prepareContinuation: () => {
              if (!recoveryPhaseBlocksContinuation(runtimeState.recoveryState.phase)) {
                return false;
              }
              clearActiveHostOverflowRecovery(runtimeState.recoveryState);
              status.refreshUi(ctx);
              return true;
            },
          }
        : fallbackOptions,
    );
  };

  return {
    onSessionStart: (async (event, ctx) => {
      continuation.clearPostCompactContinuationFallback();
      stateController.reloadFromSession(ctx);
      goalAccounting.beginAccounting();
      const goal = stateController.getGoal();
      const pausedGoal = goal?.status === "paused" ? goal : null;
      if (event.reason === "resume" && pausedGoal && ctx.hasUI) {
        const shouldResume = await ctx.ui.confirm(
          "Resume paused goal?",
          `Goal: ${pausedGoal.objective}`,
        );
        if (shouldResume) {
          resumeGoalWithContinuation(pausedGoal.goalId, "runtime", ctx);
          goalAccounting.beginAccounting();
          return;
        }
      }
      continuation.maybeContinue(ctx);
    }) satisfies ExtensionHandler<SessionStartEvent>,

    onSessionTree: (async (_event, ctx) => {
      continuation.clearPostCompactContinuationFallback();
      stateController.reloadFromSession(ctx);
      goalAccounting.beginAccounting();
      continuation.maybeContinue(ctx);
    }) satisfies ExtensionHandler<SessionTreeEvent>,

    onSessionBeforeFork: (async (_event, ctx) => {
      goalAccounting.accountProgress(ctx, false, true);
    }) satisfies ExtensionHandler<SessionBeforeForkEvent>,

    onSessionBeforeCompact: (async (_event, ctx) => {
      if (
        runStaleQueuedWorkPlan(
          runtimeState.staleQueuedWorkGuard.planSessionBeforeCompact(),
          ctx,
          deps,
        )
      ) {
        return;
      }

      goalAccounting.accountProgress(ctx, false, true);
    }) satisfies ExtensionHandler<SessionBeforeCompactEvent>,

    onSessionCompact: (async (event, ctx) => {
      if (
        runStaleQueuedWorkPlan(runtimeState.staleQueuedWorkGuard.planSessionCompact(), ctx, deps)
      ) {
        return;
      }

      goalAccounting.accountProgress(ctx, false, true);
      const wasRecoveringFromHostOverflow = recoveryPhaseBlocksContinuation(
        runtimeState.recoveryState.phase,
      );
      recoveryRuntime.onSessionCompact();
      status.refreshUi(ctx);
      if (event.willRetry) {
        schedulePostCompactContinuationFallback(ctx, {
          clearHostOverflowRecovery: wasRecoveringFromHostOverflow,
        });
        return;
      }
      if (!recoveryPhaseBlocksContinuation(runtimeState.recoveryState.phase)) {
        continuation.maybeContinueAfterCurrentEvent(ctx);
      } else if (wasRecoveringFromHostOverflow) {
        schedulePostCompactContinuationFallback(ctx, { clearHostOverflowRecovery: true });
      }
    }) satisfies ExtensionHandler<SessionCompactEvent>,

    onSessionShutdown: (async (_event, ctx) => {
      continuation.clearPostCompactContinuationFallback();
      continuation.clearPassthroughContinuationInput();
      continuation.clearContinuationTimer();
      applyStaleQueuedWorkEffects(
        runtimeState.staleQueuedWorkGuard.planSessionShutdown().effects,
        ctx,
        deps,
      );

      goalAccounting.accountProgress(ctx, false, true);
      if (hasPendingOverflowRecovery(deps)) {
        clearActiveHostOverflowRecovery(runtimeState.recoveryState);
        stateController.updateGoal("blocked", "runtime", ctx);
      } else {
        resetErrorRecovery();
      }
      status.stopStatusRefresh();
    }) satisfies ExtensionHandler<SessionShutdownEvent>,
  };
}

function hasPendingOverflowRecovery({
  runtimeState,
  stateController,
}: GoalRuntimeSessionHandlerContext): boolean {
  return (
    stateController.getGoal()?.status === "active" && runtimeState.recoveryState.overflowPending
  );
}
