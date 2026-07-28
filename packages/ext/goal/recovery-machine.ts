import {
  applyPersistedHostOverflowUserReset,
  clearHostOverflowRecoveryActive,
  hostOverflowRecoveringNeedsUserStartPhase,
  idleRecoveryPhase,
  recoveryPhaseNeedsUserStartTurn,
  type RecoveryPhase,
} from "./recovery-phase.js";
import {
  isSuccessfulAssistantTurn,
  MAX_CONTEXT_COMPACTION_RETRIES,
  type AssistantErrorMessage,
} from "./recovery.js";

export type { GoalStartTurnStrategy, RecoveryPhase } from "./recovery-phase.js";
export {
  goalStartTurnStrategy,
  recoveryPhaseBlocksContinuation,
  recoveryPhaseNeedsUserStartTurn,
} from "./recovery-phase.js";

export interface GoalRecoveryMachineState {
  overflowAttempts: number;
  overflowPending: boolean;
  phase: RecoveryPhase;
}

export function createGoalRecoveryMachine(): GoalRecoveryMachineState {
  return {
    overflowAttempts: 0,
    overflowPending: false,
    phase: idleRecoveryPhase,
  };
}

export function resetRecoveryMachine(state: GoalRecoveryMachineState): void {
  state.overflowAttempts = 0;
  state.overflowPending = false;
  clearActiveHostOverflowRecovery(state);
}

export function onRecoveryUserInput(state: GoalRecoveryMachineState): void {
  resetRecoveryMachine(state);
}

export function onRecoverySuccessfulTurn(
  state: GoalRecoveryMachineState,
  message: AssistantErrorMessage,
): boolean {
  if (!isSuccessfulAssistantTurn(message)) {
    return false;
  }
  state.overflowAttempts = 0;
  state.overflowPending = false;
  return true;
}

export function onRecoverySessionCompact(state: GoalRecoveryMachineState): void {
  state.overflowPending = false;
}

export function clearActiveHostOverflowRecovery(state: GoalRecoveryMachineState): void {
  state.phase = clearHostOverflowRecoveryActive(state.phase);
}

export function applyHostOverflowUserResetPersistence(
  state: GoalRecoveryMachineState,
  needsUserReset: boolean,
): boolean {
  if (recoveryPhaseNeedsUserStartTurn(state.phase) === needsUserReset) {
    return false;
  }
  state.phase = applyPersistedHostOverflowUserReset(state.phase, needsUserReset);
  return true;
}

export function syncHostOverflowUserResetFromSession(
  state: GoalRecoveryMachineState,
  needsUserReset: boolean,
): void {
  state.phase = applyPersistedHostOverflowUserReset(state.phase, needsUserReset);
}

/** Session-level overflow: require a user-started goal turn even without an active goal. */
export function requireHostOverflowUserReset(state: GoalRecoveryMachineState): boolean {
  const persistHostOverflowCapReset = !recoveryPhaseNeedsUserStartTurn(state.phase);
  state.phase = applyPersistedHostOverflowUserReset(state.phase, true);
  return persistHostOverflowCapReset;
}

export function beginHostOverflowRecovery(state: GoalRecoveryMachineState): {
  persistHostOverflowCapReset: boolean;
} {
  const persistHostOverflowCapReset = !recoveryPhaseNeedsUserStartTurn(state.phase);
  state.phase = hostOverflowRecoveringNeedsUserStartPhase();
  state.overflowPending = true;
  return { persistHostOverflowCapReset };
}

/** Returns true once Pi's single host compact-and-retry has already been exhausted. */
export function recordSilentContextOverflow(state: GoalRecoveryMachineState): boolean {
  state.overflowAttempts += 1;
  return state.overflowAttempts > MAX_CONTEXT_COMPACTION_RETRIES;
}
