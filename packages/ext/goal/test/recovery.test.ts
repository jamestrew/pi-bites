import assert from "node:assert/strict";
import { test } from "vitest";

import {
  isAssistantContextOverflow,
  isContextOverflowError,
  isErrorAssistantMessage,
  isProviderLimitError,
  isSuccessfulAssistantTurn,
  terminalFailureStatus,
} from "../recovery.js";
import {
  applyHostOverflowUserResetPersistence,
  beginHostOverflowRecovery,
  createGoalRecoveryMachine,
  goalStartTurnStrategy,
  onRecoverySessionCompact,
  recordSilentContextOverflow,
  recoveryPhaseBlocksContinuation,
  recoveryPhaseNeedsUserStartTurn,
  requireHostOverflowUserReset,
  resetRecoveryMachine,
} from "../recovery-machine.js";

test("detects context overflow error messages with the host classifier", () => {
  assert.equal(isContextOverflowError("context_length_exceeded: prompt too large"), true);
  assert.equal(isContextOverflowError("prompt is too long: 213462 tokens > 200000 maximum"), true);
  assert.equal(isContextOverflowError("rate limit exceeded"), false);
});

test("detects silent stop and zero-output length overflows", () => {
  const contextWindow = 128_000;
  assert.equal(
    isAssistantContextOverflow(
      {
        role: "assistant",
        stopReason: "stop",
        usage: { input: 130_000, output: 0, cacheRead: 0 },
      },
      contextWindow,
    ),
    true,
  );
  assert.equal(
    isAssistantContextOverflow(
      {
        role: "assistant",
        stopReason: "length",
        usage: { input: 127_000, output: 0, cacheRead: 1_000 },
      },
      contextWindow,
    ),
    true,
  );
  assert.equal(
    isAssistantContextOverflow(
      { role: "assistant", stopReason: "stop", usage: { input: 1_000, output: 500 } },
      contextWindow,
    ),
    false,
  );
});

const providerLimitErrors = [
  "insufficient_quota 429",
  "available balance",
  "quota exceeded",
  "billing",
  "GoUsageLimitError",
  "FreeUsageLimitError",
  "Monthly usage limit reached",
  "usage limit has been reached",
  "out of budget",
] as const;

test("provider-limit classifier recognizes quota and account limits", () => {
  for (const errorMessage of providerLimitErrors) {
    assert.equal(isProviderLimitError(errorMessage), true, errorMessage);
  }
  assert.equal(isProviderLimitError("invalid api key"), false);
  assert.equal(isProviderLimitError(undefined), false);
});

test("assistant terminal classifiers distinguish success, error, and abort", () => {
  assert.equal(isSuccessfulAssistantTurn({ role: "assistant", stopReason: "stop" }), true);
  assert.equal(isSuccessfulAssistantTurn({ role: "assistant", stopReason: "error" }), false);
  assert.equal(isSuccessfulAssistantTurn({ role: "assistant", stopReason: "aborted" }), false);
  assert.equal(isErrorAssistantMessage({ role: "assistant", stopReason: "error" }), true);
});

test("terminal failures have one canonical lifecycle classification", () => {
  assert.equal(
    terminalFailureStatus({
      role: "assistant",
      stopReason: "error",
      errorMessage: "insufficient_quota",
    }),
    "usageLimited",
  );
  assert.equal(
    terminalFailureStatus({
      role: "assistant",
      stopReason: "error",
      errorMessage: "invalid api key",
    }),
    "blocked",
  );
});

test("host overflow recovery suppresses continuation and requires a user-started turn", () => {
  const state = createGoalRecoveryMachine();
  const result = beginHostOverflowRecovery(state);

  assert.equal(result.persistHostOverflowCapReset, true);
  assert.equal(state.overflowPending, true);
  assert.equal(state.phase.kind, "hostOverflowRecoveringNeedsUserStart");
  assert.equal(recoveryPhaseBlocksContinuation(state.phase), true);
  assert.equal(recoveryPhaseNeedsUserStartTurn(state.phase), true);
  assert.equal(goalStartTurnStrategy(state.phase), "userFollowUp");
});

test("reset clears active overflow recovery while preserving the durable user-start requirement", () => {
  const state = createGoalRecoveryMachine();
  beginHostOverflowRecovery(state);
  resetRecoveryMachine(state);

  assert.equal(state.overflowPending, false);
  assert.equal(state.overflowAttempts, 0);
  assert.equal(state.phase.kind, "hostOverflowNeedsUserStart");
  assert.equal(recoveryPhaseNeedsUserStartTurn(state.phase), true);
  assert.equal(recoveryPhaseBlocksContinuation(state.phase), false);
});

test("host overflow user-reset persistence changes only when needed", () => {
  const state = createGoalRecoveryMachine();
  assert.equal(requireHostOverflowUserReset(state), true);
  assert.equal(requireHostOverflowUserReset(state), false);
  assert.equal(applyHostOverflowUserResetPersistence(state, false), true);
  assert.equal(state.phase.kind, "idle");
});

test("silent overflow blocks only after Pi's compact-and-retry is exhausted", () => {
  const state = createGoalRecoveryMachine();
  beginHostOverflowRecovery(state);

  assert.equal(recordSilentContextOverflow(state), false);
  assert.equal(state.overflowAttempts, 1);
  onRecoverySessionCompact(state);
  assert.equal(state.overflowPending, false);
  assert.equal(state.overflowAttempts, 1);
  assert.equal(recordSilentContextOverflow(state), true);
  assert.equal(state.overflowAttempts, 2);
});
