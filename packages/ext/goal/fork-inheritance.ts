import { randomUUID } from "node:crypto";

import { CUSTOM_ENTRY_TYPE, type SessionEntryLike, type ThreadGoal } from "./types.js";

export type ForkGoalEntry =
  | {
      version: 1;
      kind: "fork_transfer";
      source: "runtime";
      transferId: string;
      sourceSessionId: string;
      entryId: string;
      position: "before" | "at";
      targetLeafId: string | null;
      goal: ThreadGoal | null;
      at: number;
    }
  | {
      version: 1;
      kind: "fork_snapshot";
      source: "runtime";
      transferId: string;
      sourceSessionId: string;
      goal: ThreadGoal | null;
      continuationDeferred: boolean;
      at: number;
    }
  | {
      version: 1;
      kind: "fork_deferral";
      source: "runtime";
      transferId: string;
      active: false;
      at: number;
    };

export type ForkTransferEntry = Extract<ForkGoalEntry, { kind: "fork_transfer" }>;
export type ForkTransferLookup =
  | { kind: "none" }
  | { kind: "unsafe" }
  | { kind: "found"; transfer: ForkTransferEntry };

export interface RestoredGoalState {
  goal: ThreadGoal | null;
  inheritedTransferId: string | null;
  deferredTransferId: string | null;
}

interface SourceSessionForFork {
  getEntries(): readonly SessionEntryLike[];
  getHeader(): { id: string } | null;
}

interface SessionManagerForFork {
  getBranch(fromId?: string): readonly SessionEntryLike[];
}

const pendingUnpersistedTransfers = new Map<string, ForkTransferEntry>();

function cloneGoal(goal: ThreadGoal): ThreadGoal {
  return { ...goal, usage: { ...goal.usage } };
}

function unixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function isForkGoalEntry(
  data: unknown,
  isThreadGoal: (goal: unknown) => goal is ThreadGoal,
): data is ForkGoalEntry {
  if (!data || typeof data !== "object") return false;
  const entry = data as Record<string, unknown>;
  if (entry.version !== 1 || !Number.isSafeInteger(entry.at) || Number(entry.at) < 0) return false;

  if (entry.kind === "fork_transfer") {
    return (
      entry.source === "runtime" &&
      isNonEmptyString(entry.transferId) &&
      isNonEmptyString(entry.sourceSessionId) &&
      isNonEmptyString(entry.entryId) &&
      (entry.position === "before" || entry.position === "at") &&
      (entry.targetLeafId === null || isNonEmptyString(entry.targetLeafId)) &&
      (entry.goal === null || isThreadGoal(entry.goal))
    );
  }
  if (entry.kind === "fork_snapshot") {
    return (
      entry.source === "runtime" &&
      isNonEmptyString(entry.transferId) &&
      isNonEmptyString(entry.sourceSessionId) &&
      (entry.goal === null || isThreadGoal(entry.goal)) &&
      entry.continuationDeferred === (entry.goal !== null)
    );
  }
  return (
    entry.kind === "fork_deferral" &&
    entry.source === "runtime" &&
    isNonEmptyString(entry.transferId) &&
    entry.active === false
  );
}

export function createForkTransfer(
  sourceSessionId: string,
  entryId: string,
  position: "before" | "at",
  targetLeafId: string | null,
  goal: ThreadGoal | null,
  at = unixSeconds(),
): ForkTransferEntry {
  return {
    version: 1,
    kind: "fork_transfer",
    source: "runtime",
    transferId: randomUUID(),
    sourceSessionId,
    entryId,
    position,
    targetLeafId,
    goal: goal ? cloneGoal(goal) : null,
    at,
  };
}

export function persistForkTransfer(
  appendEntry: (customType: string, data: unknown) => unknown,
  sessionFile: string | undefined,
  options: {
    sourceSessionId: string;
    entryId: string;
    position: "before" | "at";
    targetLeafId: string | null;
    goal: ThreadGoal | null;
    destinationHasPersistenceBoundary: boolean;
  },
): ForkTransferEntry {
  const transfer = createForkTransfer(
    options.sourceSessionId,
    options.entryId,
    options.position,
    options.targetLeafId,
    options.goal,
  );
  appendEntry(CUSTOM_ENTRY_TYPE, transfer);
  if (sessionFile && !options.destinationHasPersistenceBoundary) {
    pendingUnpersistedTransfers.set(sessionFile, transfer);
  }
  return transfer;
}

export function takePendingUnpersistedTransfer(sessionFile: string): ForkTransferEntry | null {
  const transfer = pendingUnpersistedTransfers.get(sessionFile) ?? null;
  pendingUnpersistedTransfers.delete(sessionFile);
  return transfer;
}

export function clearPendingUnpersistedTransfer(sessionFile: string | undefined): void {
  if (sessionFile) pendingUnpersistedTransfers.delete(sessionFile);
}

function createForkSnapshot(
  transfer: ForkTransferEntry,
  at = unixSeconds(),
): Extract<ForkGoalEntry, { kind: "fork_snapshot" }> {
  return {
    version: 1,
    kind: "fork_snapshot",
    source: "runtime",
    transferId: transfer.transferId,
    sourceSessionId: transfer.sourceSessionId,
    goal: transfer.goal ? cloneGoal(transfer.goal) : null,
    continuationDeferred: transfer.goal !== null,
    at,
  };
}

function createClearedForkDeferral(
  transferId: string,
  at = unixSeconds(),
): Extract<ForkGoalEntry, { kind: "fork_deferral" }> {
  return {
    version: 1,
    kind: "fork_deferral",
    source: "runtime",
    transferId,
    active: false,
    at,
  };
}

export function persistForkSnapshot(
  appendEntry: (customType: string, data: unknown) => unknown,
  transfer: ForkTransferEntry,
): void {
  appendEntry(CUSTOM_ENTRY_TYPE, createForkSnapshot(transfer));
}

export function persistClearedForkDeferral(
  appendEntry: (customType: string, data: unknown) => unknown,
  transferId: string,
): void {
  appendEntry(CUSTOM_ENTRY_TYPE, createClearedForkDeferral(transferId));
}

export function applyForkInheritanceEntry(restored: RestoredGoalState, entry: ForkGoalEntry): void {
  if (entry.kind === "fork_snapshot") {
    restored.goal = entry.goal ? cloneGoal(entry.goal) : null;
    restored.inheritedTransferId = entry.transferId;
    restored.deferredTransferId = entry.continuationDeferred ? entry.transferId : null;
  } else if (entry.kind === "fork_deferral" && entry.transferId === restored.deferredTransferId) {
    restored.deferredTransferId = null;
  }
}

export function canPersistForkDestination(
  sessionManager: SessionManagerForFork,
  targetLeafId: string | null,
): boolean {
  return Boolean(
    targetLeafId &&
    sessionManager
      .getBranch(targetLeafId)
      .some((entry) => entry.type === "message" && entry.message?.role === "assistant"),
  );
}

/** Select the exact target's latest transfer using Pi's canonical session entries. */
export function readForkTransfer(
  sourceSession: SourceSessionForFork,
  destinationBranch: readonly SessionEntryLike[],
  destinationCreatedAt: string,
  isThreadGoal: (goal: unknown) => goal is ThreadGoal,
): ForkTransferLookup {
  const destinationCreatedMs = Date.parse(destinationCreatedAt);
  if (!Number.isFinite(destinationCreatedMs)) return { kind: "unsafe" };

  const sourceEntries = sourceSession.getEntries();
  const sourceSessionId = sourceSession.getHeader()?.id;
  if (!sourceSessionId) return { kind: "unsafe" };
  const sourceEntryIds = new Set(sourceEntries.map((entry) => entry.id));
  let expectedTargetLeafId: string | undefined;
  for (let index = destinationBranch.length - 1; index >= 0; index -= 1) {
    const id = destinationBranch[index]?.id;
    if (id && sourceEntryIds.has(id)) {
      expectedTargetLeafId = id;
      break;
    }
  }
  if (!expectedTargetLeafId) return { kind: "none" };

  let sawMatchingTransfer = false;
  const candidates: Array<{ transfer: ForkTransferEntry; timestampMs: number }> = [];
  for (const entry of sourceEntries) {
    if (entry.type !== "custom" || entry.customType !== CUSTOM_ENTRY_TYPE) continue;
    const data = entry.data as Record<string, unknown> | undefined;
    if (data?.kind === "fork_transfer" && data.targetLeafId === expectedTargetLeafId) {
      sawMatchingTransfer = true;
    }
    if (
      isForkGoalEntry(entry.data, isThreadGoal) &&
      entry.data.kind === "fork_transfer" &&
      entry.data.targetLeafId === expectedTargetLeafId
    ) {
      candidates.push({ transfer: entry.data, timestampMs: Date.parse(entry.timestamp ?? "") });
    }
  }

  if (candidates.length === 0) return { kind: sawMatchingTransfer ? "unsafe" : "none" };
  const eligible = candidates.filter(
    ({ timestampMs }) => Number.isFinite(timestampMs) && timestampMs <= destinationCreatedMs,
  );
  if (eligible.length === 0) return { kind: "unsafe" };
  const latestTimestamp = Math.max(...eligible.map(({ timestampMs }) => timestampMs));
  const latest = eligible.filter(({ timestampMs }) => timestampMs === latestTimestamp);
  return latest.length === 1 && latest[0]?.transfer.sourceSessionId === sourceSessionId
    ? { kind: "found", transfer: latest[0].transfer }
    : { kind: "unsafe" };
}
