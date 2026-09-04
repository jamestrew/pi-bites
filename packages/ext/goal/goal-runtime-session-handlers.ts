import { SessionManager } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionContext,
  ExtensionHandler,
  SessionBeforeCompactEvent,
  SessionBeforeForkEvent,
  SessionBeforeTreeEvent,
  SessionCompactEvent,
  SessionShutdownEvent,
  SessionStartEvent,
  SessionTreeEvent,
} from "@earendil-works/pi-coding-agent";

import {
  canPersistForkDestination,
  clearPendingUnpersistedTransfer,
  readForkTransfer,
  takePendingUnpersistedTransfer,
} from "./fork-inheritance.js";
import {
  clearActiveHostOverflowRecovery,
  recoveryPhaseBlocksContinuation,
} from "./recovery-machine.js";
import { applyStaleQueuedWorkEffects, runStaleQueuedWorkPlan } from "./goal-runtime-event-utils.js";
import { isThreadGoal } from "./state.js";
import type {
  GoalRuntimeSessionHandlerContext,
  SessionCompactFailedEvent,
} from "./goal-runtime-event-handler-types.js";

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

  const blockPendingOverflowRecovery = (ctx: ExtensionContext): boolean => {
    if (!hasPendingOverflowRecovery(deps)) {
      return false;
    }
    stateController.updateGoal("blocked", "runtime", ctx);
    return true;
  };

  return {
    onSessionStart: (async (event, ctx) => {
      continuation.clearPostCompactContinuationFallback();
      stateController.reloadFromSession(ctx);
      const destinationHeader = ctx.sessionManager.getHeader();
      const parentSessionFile =
        event.reason === "fork"
          ? event.previousSessionFile
          : event.reason === "startup"
            ? destinationHeader?.parentSession
            : undefined;
      if (parentSessionFile && destinationHeader && !stateController.hasInheritedForkSnapshot()) {
        try {
          const destinationBranch = ctx.sessionManager.getBranch();
          const pendingUnpersistedTransfer =
            event.reason === "fork" &&
            !destinationBranch.some(
              (entry) => entry.type === "message" && entry.message.role === "assistant",
            )
              ? takePendingUnpersistedTransfer(parentSessionFile)
              : null;
          const lookup = pendingUnpersistedTransfer
            ? { kind: "found" as const, transfer: pendingUnpersistedTransfer }
            : readForkTransfer(
                SessionManager.open(parentSessionFile),
                destinationBranch,
                destinationHeader.timestamp,
                isThreadGoal,
              );
          if (lookup.kind === "unsafe") {
            ctx.ui.notify(
              "Goal fork intent is missing or ambiguous; automatic goal startup was disabled for safety.",
              "error",
            );
            return;
          }
          if (lookup.kind === "found") {
            stateController.inheritForkSnapshot(lookup.transfer, ctx);
          }
        } catch (error) {
          ctx.ui.notify(
            `Could not inherit goal snapshot: ${error instanceof Error ? error.message : String(error)}`,
            "error",
          );
          return;
        }
      }
      if (!stateController.isContinuationDeferred()) {
        goalAccounting.beginAccounting();
      }
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

    onSessionBeforeTree: (async (_event, ctx) => {
      if (!ctx.isIdle()) {
        ctx.abort();
      }
    }) satisfies ExtensionHandler<SessionBeforeTreeEvent>,

    onSessionTree: (async (_event, ctx) => {
      continuation.clearPostCompactContinuationFallback();
      continuation.clearContinuationState();
      continuation.clearPassthroughContinuationInput();
      goalAccounting.resetForNavigation();
      resetErrorRecovery();
      runtimeState.staleQueuedWorkGuard.reset();
      runtimeState.currentTurnIndex = null;
      runtimeState.turnEndAccounted = false;
      runtimeState.agentRunSequence += 1;

      stateController.reloadFromSession(ctx);
      if (!stateController.isContinuationDeferred()) {
        goalAccounting.beginAccounting();
      }
      continuation.maybeContinueAfterCurrentEvent(ctx);
    }) satisfies ExtensionHandler<SessionTreeEvent>,

    onSessionBeforeFork: (async (event, ctx) => {
      clearPendingUnpersistedTransfer(ctx.sessionManager.getSessionFile());
      const goal = stateController.getGoal();
      const selectedEntry = ctx.sessionManager.getEntry(event.entryId);
      const targetLeafId =
        event.position === "at" ? event.entryId : (selectedEntry?.parentId ?? null);
      const durableDestination = Boolean(
        targetLeafId && canPersistForkDestination(ctx.sessionManager, targetLeafId),
      );
      if (!goal && !durableDestination) {
        return;
      }

      try {
        if (goal) {
          goalAccounting.accountProgress(ctx, false, true);
        }
        stateController.prepareForkTransfer(
          ctx.sessionManager.getSessionId(),
          event.entryId,
          event.position,
          targetLeafId,
          ctx.sessionManager.getSessionFile(),
          durableDestination,
        );
      } catch (error) {
        ctx.ui.notify(
          `Could not prepare goal inheritance: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
        return { cancel: true };
      }
    }) satisfies ExtensionHandler<SessionBeforeForkEvent, { cancel: true } | undefined>,

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

    onSessionCompactFailed: (async (_event, ctx) => {
      if (
        runStaleQueuedWorkPlan(runtimeState.staleQueuedWorkGuard.planSessionCompact(), ctx, deps)
      ) {
        return;
      }
      if (!blockPendingOverflowRecovery(ctx)) {
        continuation.maybeContinueAfterCurrentEvent(ctx);
      }
    }) satisfies ExtensionHandler<SessionCompactFailedEvent>,

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
      if (!blockPendingOverflowRecovery(ctx)) {
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
