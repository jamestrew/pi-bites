import {
  onRecoverySessionCompact,
  onRecoverySuccessfulTurn,
  onRecoveryUserInput,
  recordSilentContextOverflow,
  type GoalRecoveryMachineState,
} from "./recovery-machine.js";
import type { AssistantErrorMessage } from "./recovery.js";
import type { ThreadGoal } from "./types.js";

interface RecoveryRuntimeDeps<TContext> {
  getGoal: () => ThreadGoal | null;
  getRecoveryState: () => GoalRecoveryMachineState;
  blockGoalForOverflow: (ctx: TContext) => void;
  refreshUi: (ctx: TContext) => void;
  maybeContinue: (ctx: TContext) => void;
}

export function createGoalRecoveryRuntime<TContext>(deps: RecoveryRuntimeDeps<TContext>) {
  const handleSilentContextOverflow = (ctx: TContext): void => {
    const goal = deps.getGoal();
    if (!goal || goal.status !== "active") {
      return;
    }

    if (recordSilentContextOverflow(deps.getRecoveryState())) {
      deps.blockGoalForOverflow(ctx);
    }
  };

  const finishSuccessfulAssistantTurn = (
    message: AssistantErrorMessage,
    ctx: TContext,
    options?: { continueGoal?: boolean },
  ): void => {
    if (onRecoverySuccessfulTurn(deps.getRecoveryState(), message)) {
      deps.refreshUi(ctx);
      if (options?.continueGoal !== false) {
        deps.maybeContinue(ctx);
      }
    }
  };

  return {
    onUserInput: () => onRecoveryUserInput(deps.getRecoveryState()),
    onSessionCompact: () => onRecoverySessionCompact(deps.getRecoveryState()),
    handleSilentContextOverflow,
    finishSuccessfulAssistantTurn,
  };
}
