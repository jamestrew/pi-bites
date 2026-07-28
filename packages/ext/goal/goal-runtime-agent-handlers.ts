import type {
  AgentEndEvent,
  AgentStartEvent,
  ExtensionHandler,
} from "@earendil-works/pi-coding-agent";

import { isAbortedAssistantMessage } from "./goal-accounting.js";
import { isErrorAssistantMessage, terminalFailureStatus } from "./recovery.js";
import {
  recordAssistantContextOverflow,
  runStaleQueuedWorkPlan,
} from "./goal-runtime-event-utils.js";
import type { GoalRuntimeAgentHandlerContext } from "./goal-runtime-event-handler-types.js";

export function createAgentEventHandlers(deps: GoalRuntimeAgentHandlerContext) {
  const { runtimeState, stateController, continuation, goalAccounting, resetErrorRecovery } = deps;

  return {
    onAgentStart: (async () => {
      runtimeState.agentRunSequence += 1;
      runtimeState.turnEndAccounted = false;
    }) satisfies ExtensionHandler<AgentStartEvent>,

    onAgentEnd: (async (event, ctx) => {
      continuation.clearPassthroughContinuationInput();
      if (
        runStaleQueuedWorkPlan(
          runtimeState.staleQueuedWorkGuard.planAgentEnd(event.messages),
          ctx,
          deps,
        )
      ) {
        return;
      }

      const expectedGoalId = runtimeState.accounting.activeGoalId;
      const abortedMessages = event.messages.filter(isAbortedAssistantMessage);
      if (!runtimeState.turnEndAccounted) {
        const lastAbortedMessage = abortedMessages.at(-1);
        if (lastAbortedMessage) {
          goalAccounting.observeAssistantUsage(lastAbortedMessage);
        }
      }
      goalAccounting.accountProgress(ctx, false, true);
      stateController.flushGoalPersistence("runtime");
      if (abortedMessages.length > 0) {
        return;
      }
      const errorMessages = event.messages.filter(isErrorAssistantMessage);
      const lastError = errorMessages.at(-1);
      if (lastError) {
        stateController.updateGoal(
          terminalFailureStatus(lastError),
          "runtime",
          ctx,
          expectedGoalId,
        );
        return;
      }

      const lastAssistant = [...event.messages]
        .reverse()
        .find((message) => message.role === "assistant");
      if (lastAssistant && recordAssistantContextOverflow(lastAssistant, ctx, deps)) {
        return;
      }
      resetErrorRecovery();
      continuation.maybeContinue(ctx);
    }) satisfies ExtensionHandler<AgentEndEvent>,
  };
}
