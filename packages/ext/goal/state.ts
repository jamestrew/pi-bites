import { randomUUID } from "node:crypto";

import {
  applyForkInheritanceEntry,
  isForkGoalEntry,
  reconstructForkInheritanceBaseline,
  type RestoredGoalState,
} from "./fork-inheritance.js";
import {
  CUSTOM_ENTRY_TYPE,
  MAX_OBJECTIVE_CHARS,
  type GoalCustomEntry,
  type GoalEntrySource,
  type GoalResult,
  type GoalStatus,
  type GoalUsage,
  type RuntimeUsageGoalStatus,
  type SessionEntryLike,
  type ThreadGoal,
} from "./types.js";

export interface ApplyUsageOptions {
  expectedGoalId?: string | null;
  accountBudgetLimited?: boolean;
}

export function unixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function cloneUsage(usage: GoalUsage): GoalUsage {
  return { ...usage };
}

export function cloneGoal(goal: ThreadGoal): ThreadGoal {
  return {
    ...goal,
    usage: cloneUsage(goal.usage),
  };
}

export function goalsEquivalent(left: ThreadGoal, right: ThreadGoal): boolean {
  return (
    left.goalId === right.goalId &&
    left.objective === right.objective &&
    left.status === right.status &&
    left.tokenBudget === right.tokenBudget &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt &&
    left.usage.tokensUsed === right.usage.tokensUsed &&
    left.usage.activeSeconds === right.usage.activeSeconds
  );
}

export function validateObjective(objective: string): string | null {
  const trimmed = objective.trim();
  if (trimmed.length === 0) {
    return "Objective must not be empty.";
  }
  if (Array.from(trimmed).length > MAX_OBJECTIVE_CHARS) {
    return `Objective must be ${MAX_OBJECTIVE_CHARS} characters or fewer.`;
  }
  return null;
}

export function isPositiveTokenBudget(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function validateTokenBudget(tokenBudget: number | null | undefined): string | null {
  if (tokenBudget === null || tokenBudget === undefined) {
    return null;
  }
  return isPositiveTokenBudget(tokenBudget) ? null : "Token budget must be a positive integer.";
}

export function statusAfterBudgetLimit(
  status: GoalStatus,
  tokensUsed: number,
  tokenBudget: number | null,
): GoalStatus {
  if (status === "active" && tokenBudget !== null && tokensUsed >= tokenBudget) {
    return "budgetLimited";
  }
  return status;
}

export function createThreadGoal(
  objective: string,
  tokenBudget?: number | null,
  now = unixSeconds(),
): ThreadGoal {
  return {
    goalId: randomUUID(),
    objective: objective.trim(),
    status: "active",
    tokenBudget: tokenBudget ?? null,
    usage: {
      tokensUsed: 0,
      activeSeconds: 0,
    },
    createdAt: now,
    updatedAt: now,
  };
}

export function setEntry(
  goal: ThreadGoal,
  source: GoalEntrySource,
  at = unixSeconds(),
): GoalCustomEntry {
  return {
    version: 1,
    kind: "set",
    source,
    goal: cloneGoal(goal),
    at,
  };
}

export function runtimeUsageEntry(goal: ThreadGoal, at = unixSeconds()): GoalCustomEntry {
  if (!isRuntimeUsageGoalStatus(goal.status)) {
    throw new Error(`Cannot persist ${goal.status} goal as runtime usage entry.`);
  }
  return {
    version: 1,
    kind: "usage",
    source: "runtime",
    goalId: goal.goalId,
    status: goal.status,
    usage: cloneUsage(goal.usage),
    updatedAt: goal.updatedAt,
    at,
  };
}

export function clearEntry(
  clearedGoalId: string | null,
  source: GoalEntrySource,
  at = unixSeconds(),
): GoalCustomEntry {
  return {
    version: 1,
    kind: "clear",
    source,
    clearedGoalId,
    at,
  };
}

export function hostOverflowCapResetEntry(active: boolean, at = unixSeconds()): GoalCustomEntry {
  return {
    version: 1,
    kind: "host_overflow_cap_reset",
    active,
    at,
  };
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isGoalEntrySource(source: unknown): source is GoalEntrySource {
  return source === "command" || source === "tool" || source === "runtime";
}

export function isGoalCustomEntry(data: unknown): data is GoalCustomEntry {
  if (!data || typeof data !== "object") {
    return false;
  }
  const entry = data as Record<string, unknown>;
  if (entry.version !== 1 || !isNonNegativeSafeInteger(entry.at)) {
    return false;
  }
  if (entry.kind === "clear") {
    return (
      isGoalEntrySource(entry.source) &&
      (entry.clearedGoalId === null || typeof entry.clearedGoalId === "string")
    );
  }
  if (entry.kind === "usage") {
    return (
      entry.source === "runtime" &&
      typeof entry.goalId === "string" &&
      entry.goalId.length > 0 &&
      isRuntimeUsageGoalStatus(entry.status) &&
      isGoalUsage(entry.usage) &&
      isNonNegativeSafeInteger(entry.updatedAt)
    );
  }
  if (entry.kind === "host_overflow_cap_reset") {
    return typeof entry.active === "boolean";
  }
  if (isForkGoalEntry(entry, isThreadGoal)) {
    return true;
  }
  return entry.kind === "set" && isGoalEntrySource(entry.source) && isThreadGoal(entry.goal);
}

export function isGoalUsage(usage: unknown): usage is GoalUsage {
  if (!usage || typeof usage !== "object") {
    return false;
  }
  const candidate = usage as GoalUsage;
  return (
    isNonNegativeSafeInteger(candidate.tokensUsed) &&
    isNonNegativeSafeInteger(candidate.activeSeconds)
  );
}

export function isRuntimeUsageGoalStatus(status: unknown): status is RuntimeUsageGoalStatus {
  return status === "active" || status === "budgetLimited";
}

export function isThreadGoal(goal: unknown): goal is ThreadGoal {
  if (!goal || typeof goal !== "object") {
    return false;
  }
  const candidate = goal as ThreadGoal;
  return (
    typeof candidate.goalId === "string" &&
    candidate.goalId.length > 0 &&
    typeof candidate.objective === "string" &&
    candidate.objective === candidate.objective.trim() &&
    validateObjective(candidate.objective) === null &&
    isGoalStatus(candidate.status) &&
    (candidate.tokenBudget === null || isPositiveTokenBudget(candidate.tokenBudget)) &&
    isNonNegativeSafeInteger(candidate.createdAt) &&
    isNonNegativeSafeInteger(candidate.updatedAt) &&
    candidate.updatedAt >= candidate.createdAt &&
    isGoalUsage(candidate.usage)
  );
}

export function isGoalStatus(status: unknown): status is GoalStatus {
  return (
    status === "active" ||
    status === "paused" ||
    status === "blocked" ||
    status === "usageLimited" ||
    status === "budgetLimited" ||
    status === "complete"
  );
}

function canApplyRuntimeUsageEntry(
  goal: ThreadGoal | null,
  entry: Extract<GoalCustomEntry, { kind: "usage" }>,
): goal is ThreadGoal {
  if (!goal || goal.goalId !== entry.goalId) {
    return false;
  }
  if (!isRuntimeUsageGoalStatus(goal.status)) {
    return false;
  }
  if (goal.status === "budgetLimited" && entry.status === "active") {
    return false;
  }
  return (
    entry.updatedAt >= goal.updatedAt &&
    entry.usage.tokensUsed >= goal.usage.tokensUsed &&
    entry.usage.activeSeconds >= goal.usage.activeSeconds
  );
}

function applyGoalEntry(restored: RestoredGoalState, data: GoalCustomEntry): void {
  if (data.kind === "clear") {
    restored.goal = null;
  } else if (data.kind === "set") {
    restored.goal = cloneGoal(data.goal);
  } else if (data.kind === "usage") {
    if (!canApplyRuntimeUsageEntry(restored.goal, data)) return;
    restored.goal = cloneGoal(restored.goal);
    restored.goal.status = data.status;
    restored.goal.usage = cloneUsage(data.usage);
    restored.goal.updatedAt = data.updatedAt;
  } else if (isForkGoalEntry(data, isThreadGoal)) {
    applyForkInheritanceEntry(restored, data);
  }
}

export function reconstructGoal(entries: Iterable<SessionEntryLike>): RestoredGoalState {
  const restored: RestoredGoalState = {
    goal: null,
    inheritedTransferId: null,
    deferredTransferId: null,
  };

  for (const entry of entries) {
    if (
      entry.type === "custom" &&
      entry.customType === CUSTOM_ENTRY_TYPE &&
      isGoalCustomEntry(entry.data)
    ) {
      applyGoalEntry(restored, entry.data);
    }
  }
  return restored;
}

/** Fold the selected branch over immutable child inheritance metadata. */
export function reconstructSessionGoal(
  branch: readonly SessionEntryLike[],
  allEntries: readonly SessionEntryLike[],
): RestoredGoalState {
  const baseline = reconstructForkInheritanceBaseline(allEntries, isThreadGoal);
  if (!baseline) return reconstructGoal(branch);

  const branchContainsSnapshot = branch.some((entry) => entry.id === baseline.snapshotEntryId);
  const restored: RestoredGoalState = branchContainsSnapshot
    ? reconstructGoal(branch)
    : {
        goal: baseline.goal ? cloneGoal(baseline.goal) : null,
        inheritedTransferId: baseline.inheritedTransferId,
        deferredTransferId: baseline.deferredTransferId,
      };

  if (!branchContainsSnapshot) {
    const snapshotIndex = allEntries.findIndex((entry) => entry.id === baseline.snapshotEntryId);
    const entryIndexes = new Map(allEntries.map((entry, index) => [entry.id, index]));
    for (const entry of branch) {
      if (
        (entryIndexes.get(entry.id) ?? -1) <= snapshotIndex ||
        entry.type !== "custom" ||
        entry.customType !== CUSTOM_ENTRY_TYPE ||
        !isGoalCustomEntry(entry.data) ||
        isForkGoalEntry(entry.data, isThreadGoal)
      ) {
        continue;
      }
      applyGoalEntry(restored, entry.data);
    }
  }

  restored.inheritedTransferId = baseline.inheritedTransferId;
  restored.deferredTransferId = baseline.deferredTransferId;
  return restored;
}

export function reconstructHostOverflowCapNeedsUserReset(
  entries: Iterable<SessionEntryLike>,
): boolean {
  let needsReset = false;

  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== CUSTOM_ENTRY_TYPE) {
      continue;
    }
    if (!isGoalCustomEntry(entry.data)) {
      continue;
    }
    if (entry.data.kind === "host_overflow_cap_reset") {
      needsReset = entry.data.active;
    }
  }

  return needsReset;
}

export function createGoal(
  current: ThreadGoal | null,
  objective: string,
  tokenBudget?: number | null,
): GoalResult {
  if (current && current.status !== "complete") {
    return {
      ok: false,
      message:
        "cannot create a new goal because this thread already has a non-complete goal; use update_goal to mark it complete, /goal clear, or /goal <objective> to replace it",
      goal: current,
    };
  }

  const objectiveError = validateObjective(objective);
  if (objectiveError) {
    return { ok: false, message: objectiveError, goal: null };
  }

  const budgetError = validateTokenBudget(tokenBudget);
  if (budgetError) {
    return { ok: false, message: budgetError, goal: null };
  }

  const goal = createThreadGoal(objective, tokenBudget);
  return {
    ok: true,
    message: "Goal created.",
    goal,
  };
}

export function replaceGoal(objective: string, tokenBudget?: number | null): GoalResult {
  const objectiveError = validateObjective(objective);
  if (objectiveError) {
    return { ok: false, message: objectiveError, goal: null };
  }

  const budgetError = validateTokenBudget(tokenBudget);
  if (budgetError) {
    return { ok: false, message: budgetError, goal: null };
  }

  const goal = createThreadGoal(objective, tokenBudget);
  return {
    ok: true,
    message: "Goal set.",
    goal,
  };
}

export function updateGoalStatus(current: ThreadGoal | null, status: GoalStatus): GoalResult {
  if (!current) {
    return {
      ok: false,
      message: "No active goal exists.",
      goal: null,
    };
  }

  if (current.status === "complete") {
    if (status === "complete") {
      return {
        ok: true,
        message: "Goal already complete.",
        goal: current,
      };
    }
    return {
      ok: false,
      message:
        "Completed goals are terminal; use /goal <objective> to replace or /goal clear before changing status.",
      goal: current,
    };
  }

  if (status === "complete") {
    const goal = cloneGoal(current);
    goal.status = "complete";
    goal.updatedAt = unixSeconds();
    return {
      ok: true,
      message: "Goal marked complete.",
      goal,
    };
  }

  if (status === "paused" && current.status !== "active") {
    return {
      ok: false,
      message: "Only active goals can be paused.",
      goal: current,
    };
  }

  if (
    status === "active" &&
    current.status !== "paused" &&
    current.status !== "blocked" &&
    current.status !== "usageLimited"
  ) {
    return {
      ok: false,
      message: "Only paused, blocked, or usage-limited goals can be resumed.",
      goal: current,
    };
  }

  if (
    status === "usageLimited" &&
    current.status !== "active" &&
    current.status !== "budgetLimited"
  ) {
    return {
      ok: false,
      message: "Only a goal active at failure time can become usage-limited.",
      goal: current,
    };
  }

  const goal = cloneGoal(current);
  goal.status = statusAfterBudgetLimit(status, goal.usage.tokensUsed, goal.tokenBudget);
  goal.updatedAt = unixSeconds();

  return {
    ok: true,
    message: `Goal marked ${goal.status}.`,
    goal,
  };
}

export function applyUsage(
  current: ThreadGoal | null,
  tokensDelta: number,
  activeSecondsDelta: number,
  options: ApplyUsageOptions = {},
): { goal: ThreadGoal | null; changed: boolean; crossedBudget: boolean } {
  if (!current) {
    return { goal: current, changed: false, crossedBudget: false };
  }

  if (
    options.expectedGoalId !== undefined &&
    options.expectedGoalId !== null &&
    current.goalId !== options.expectedGoalId
  ) {
    return { goal: current, changed: false, crossedBudget: false };
  }

  const canAccount =
    current.status === "active" ||
    (options.accountBudgetLimited === true && current.status === "budgetLimited");
  if (!canAccount) {
    return { goal: current, changed: false, crossedBudget: false };
  }

  const tokens = Math.max(0, Math.trunc(tokensDelta));
  const seconds = Math.max(0, Math.trunc(activeSecondsDelta));
  if (tokens === 0 && seconds === 0) {
    return { goal: current, changed: false, crossedBudget: false };
  }

  const goal = cloneGoal(current);
  const wasUnderBudget = goal.tokenBudget === null || goal.usage.tokensUsed < goal.tokenBudget;
  goal.usage.tokensUsed += tokens;
  goal.usage.activeSeconds += seconds;
  goal.status = statusAfterBudgetLimit(goal.status, goal.usage.tokensUsed, goal.tokenBudget);
  goal.updatedAt = unixSeconds();

  const crossedBudget =
    current.status === "active" &&
    wasUnderBudget &&
    goal.tokenBudget !== null &&
    goal.usage.tokensUsed >= goal.tokenBudget;

  return { goal, changed: true, crossedBudget };
}

export function goalWithLiveUsage(
  current: ThreadGoal | null,
  activeGoalId: string | null,
  lastAccountedAt: number | null,
  now = performance.now(),
  elapsedCarryMs = 0,
): ThreadGoal | null {
  if (
    !current ||
    current.status !== "active" ||
    activeGoalId !== current.goalId ||
    lastAccountedAt === null
  ) {
    return current;
  }

  const liveSeconds = Math.max(
    0,
    Math.floor((elapsedCarryMs + Math.max(0, now - lastAccountedAt)) / 1000),
  );
  if (liveSeconds === 0) {
    return current;
  }

  const goal = cloneGoal(current);
  goal.usage.activeSeconds += liveSeconds;
  return goal;
}
