import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { budgetLimitPrompt } from "./prompts.js";
import { applyUsage } from "./state.js";
import { CUSTOM_ENTRY_TYPE, type ThreadGoal } from "./types.js";

export interface AccountingState {
  activeGoalId: string | null;
  lastAccountedAt: number | null;
  elapsedCarryMs: number;
  elapsedCarryGoalId: string | null;
  currentTurnTokens: number;
  lastAccountedTurnTokens: number;
  turnChargeable: boolean;
  budgetWarningSentFor: string | null;
}

export interface AssistantUsage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
}

export interface AssistantTurnMessage {
  role: string;
  stopReason?: string;
  usage?: AssistantUsage;
}

export interface NormalizedProviderUsage {
  uncachedInput: number;
  output: number;
}

export interface GoalAccountingOptions {
  monotonicNow?: () => number;
}

export function createAccountingState(): AccountingState {
  return {
    activeGoalId: null,
    lastAccountedAt: null,
    elapsedCarryMs: 0,
    elapsedCarryGoalId: null,
    currentTurnTokens: 0,
    lastAccountedTurnTokens: 0,
    turnChargeable: true,
    budgetWarningSentFor: null,
  };
}

function usageChannelTokens(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.trunc(value));
}

/** Normalize Pi's canonical split usage and legacy/provider shapes at one boundary. */
export function normalizeProviderUsage(usage: AssistantUsage): NormalizedProviderUsage {
  const input = usageChannelTokens(usage.input);
  const output = usageChannelTokens(usage.output);
  const cacheRead = usageChannelTokens(usage.cacheRead);
  const cacheWrite = usageChannelTokens(usage.cacheWrite);
  const totalTokens = usageChannelTokens(usage.totalTokens);

  // Pi's canonical Usage.input is already uncached and totalTokens contains every split.
  // Some provider fixtures instead report cached tokens as subsets of input, in which case
  // totalTokens is input + output. Only subtract when that shape is unambiguous.
  const cacheIncludedInInput =
    cacheRead + cacheWrite > 0 && totalTokens === input + output && totalTokens > 0;

  return {
    uncachedInput: cacheIncludedInInput ? Math.max(0, input - cacheRead - cacheWrite) : input,
    output,
  };
}

export function assistantTurnTokens(message: AssistantTurnMessage): number {
  if (message.role !== "assistant" || !message.usage) {
    return 0;
  }
  const usage = normalizeProviderUsage(message.usage);
  return usage.uncachedInput + usage.output;
}

export function isAbortedAssistantMessage(message: AssistantTurnMessage): boolean {
  return message.role === "assistant" && message.stopReason === "aborted";
}

export function isToolUseAssistantMessage(message: AssistantTurnMessage): boolean {
  return message.role === "assistant" && message.stopReason === "toolUse";
}

interface GoalAccountingDeps {
  getGoal: () => ThreadGoal | null;
  getAccounting: () => AccountingState;
  applyRuntimeAccountingTransition: (ctx: ExtensionContext, nextGoal: ThreadGoal) => void;
  sendMessage: ExtensionAPI["sendMessage"];
}

export function createGoalAccounting(
  deps: GoalAccountingDeps,
  options: GoalAccountingOptions = {},
) {
  const monotonicNow = options.monotonicNow ?? (() => performance.now());

  const detach = ({ preserveCarry = true }: { preserveCarry?: boolean } = {}): void => {
    const accounting = deps.getAccounting();
    accounting.activeGoalId = null;
    accounting.lastAccountedAt = null;
    accounting.lastAccountedTurnTokens = 0;
    if (!preserveCarry) {
      accounting.elapsedCarryMs = 0;
      accounting.elapsedCarryGoalId = null;
    }
  };

  const beginAccounting = (): void => {
    const goal = deps.getGoal();
    const accounting = deps.getAccounting();
    if (!goal || goal.status !== "active") {
      detach();
      return;
    }

    if (accounting.elapsedCarryGoalId !== goal.goalId) {
      accounting.elapsedCarryMs = 0;
    }
    accounting.elapsedCarryGoalId = goal.goalId;
    accounting.activeGoalId = goal.goalId;
    accounting.lastAccountedAt = monotonicNow();
    // Attaching a goal during an existing turn must not charge usage from before creation.
    accounting.lastAccountedTurnTokens = accounting.currentTurnTokens;
  };

  const beginTurn = (chargeable = true): void => {
    const accounting = deps.getAccounting();
    accounting.currentTurnTokens = 0;
    accounting.lastAccountedTurnTokens = 0;
    accounting.turnChargeable = chargeable;
    beginAccounting();
  };

  const observeAssistantUsage = (message: AssistantTurnMessage): void => {
    const accounting = deps.getAccounting();
    if (!accounting.turnChargeable) {
      return;
    }
    // Provider snapshots are cumulative. Keep the high-water mark so malformed,
    // decreasing, or repeated snapshots cannot rewind or double-charge a turn.
    accounting.currentTurnTokens = Math.max(
      accounting.currentTurnTokens,
      assistantTurnTokens(message),
    );
  };

  const accountProgress = (
    ctx: ExtensionContext,
    allowBudgetSteering: boolean,
    accountBudgetLimited = false,
  ): void => {
    const goal = deps.getGoal();
    const accounting = deps.getAccounting();
    const canAccount =
      goal?.status === "active" || (accountBudgetLimited && goal?.status === "budgetLimited");
    if (!goal || accounting.activeGoalId !== goal.goalId || !canAccount) {
      beginAccounting();
      return;
    }

    const observedNow = monotonicNow();
    const now =
      accounting.lastAccountedAt === null
        ? observedNow
        : Math.max(accounting.lastAccountedAt, observedNow);
    const elapsedMs =
      accounting.elapsedCarryMs +
      (accounting.lastAccountedAt === null ? 0 : now - accounting.lastAccountedAt);
    const elapsedSeconds = Math.floor(elapsedMs / 1000);
    const nextCarryMs = elapsedMs - elapsedSeconds * 1000;
    const tokenDelta = Math.max(
      0,
      accounting.currentTurnTokens - accounting.lastAccountedTurnTokens,
    );

    const result = applyUsage(goal, tokenDelta, elapsedSeconds, {
      expectedGoalId: accounting.activeGoalId,
      accountBudgetLimited,
    });
    if (result.changed && result.goal) {
      deps.applyRuntimeAccountingTransition(ctx, result.goal);
    }

    // Advance baselines only after the durable transition succeeds. A budget crossing
    // clears active accounting as part of that transition, so do not revive it here.
    if (accounting.activeGoalId === goal.goalId) {
      accounting.lastAccountedAt = now;
      accounting.elapsedCarryMs = nextCarryMs;
      accounting.lastAccountedTurnTokens = accounting.currentTurnTokens;
    }

    if (
      allowBudgetSteering &&
      result.crossedBudget &&
      result.goal &&
      accounting.budgetWarningSentFor !== result.goal.goalId
    ) {
      accounting.budgetWarningSentFor = result.goal.goalId;
      deps.sendMessage(
        {
          customType: CUSTOM_ENTRY_TYPE,
          content: budgetLimitPrompt(result.goal),
          display: false,
          details: { kind: "budget_limit", goalId: result.goal.goalId },
        },
        { triggerTurn: true, deliverAs: "steer" },
      );
    }
  };

  return {
    detach,
    beginAccounting,
    beginTurn,
    observeAssistantUsage,
    accountProgress,
  };
}
