import type {
  ExtensionHandler,
  TurnEndEvent,
  TurnStartEvent,
} from "@earendil-works/pi-coding-agent";

import {
  assistantTurnTokens,
  isAbortedAssistantMessage,
  isToolUseAssistantMessage,
} from "./goal-accounting.js";
import {
  isAssistantContextOverflow,
  isErrorAssistantMessage,
  terminalFailureStatus,
} from "./recovery.js";
import { getContextWindow, runStaleQueuedWorkPlan } from "./goal-runtime-event-utils.js";
import type {
  GoalRuntimeTurnHandlerContext,
  ToolExecutionEndEvent,
} from "./goal-runtime-event-handler-types.js";

export function createTurnEventHandlers(deps: GoalRuntimeTurnHandlerContext) {
  const { runtimeState, stateController, continuation, goalAccounting, recoveryRuntime, status } =
    deps;

  return {
    onTurnStart: (async (event, ctx) => {
      runtimeState.currentTurnIndex = event.turnIndex;
      runtimeState.turnEndAccounted = false;
      continuation.bindPassthroughContinuationInputToTurn(event.turnIndex);
      runStaleQueuedWorkPlan(runtimeState.staleQueuedWorkGuard.planTurnStart(), ctx, deps);
      goalAccounting.beginAccounting();
      status.refreshUi(ctx);
    }) satisfies ExtensionHandler<TurnStartEvent>,

    onToolExecutionEnd: (async (_event, ctx) => {
      if (
        runStaleQueuedWorkPlan(runtimeState.staleQueuedWorkGuard.planToolExecutionEnd(), ctx, deps)
      ) {
        return;
      }

      goalAccounting.accountProgress(ctx, true, 0, true);
      stateController.maybeFlushRuntimePersistence("runtime");
    }) satisfies ExtensionHandler<ToolExecutionEndEvent>,

    onTurnEnd: (async (event, ctx) => {
      if (
        runStaleQueuedWorkPlan(
          runtimeState.staleQueuedWorkGuard.planTurnEnd(event.turnIndex),
          ctx,
          deps,
        )
      ) {
        return;
      }

      const expectedGoalId = runtimeState.accounting.activeGoalId;
      const completedTurnTokens = assistantTurnTokens(event.message);
      goalAccounting.accountProgress(ctx, true, completedTurnTokens);
      runtimeState.turnEndAccounted = true;
      stateController.flushGoalPersistence("runtime");
      if (isAbortedAssistantMessage(event.message)) {
        return;
      }
      if (isErrorAssistantMessage(event.message)) {
        stateController.updateGoal(
          terminalFailureStatus(event.message),
          "runtime",
          ctx,
          expectedGoalId,
        );
        return;
      }
      if (isAssistantContextOverflow(event.message, getContextWindow(ctx))) {
        stateController.beginOverflowRecovery(ctx);
        return;
      }
      recoveryRuntime.finishSuccessfulAssistantTurn(event.message, ctx, {
        continueGoal: !isToolUseAssistantMessage(event.message),
      });
    }) satisfies ExtensionHandler<TurnEndEvent>,
  };
}
