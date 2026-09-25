import { buildSessionProjection, type SessionEntry } from "@earendil-works/pi-coding-agent";

export const MAX_ENTRY_CHARS = 8_000;

// Compaction hides messages from model context, not from the active branch.
// Reuse Pi's edit projection over that branch without its compaction cutoffs.
// Rewire copies only: removing a compaction must not break the parent chain.
export function reviewerEvidence(branch: SessionEntry[]) {
  const uncompacted = branch.filter((entry) => entry.type !== "compaction");
  return buildSessionProjection(
    uncompacted.map((entry, index) => ({
      ...entry,
      parentId: uncompacted[index - 1]?.id ?? null,
    })),
  ).entries;
}

export function historyCoverage(branch: SessionEntry[]): string {
  const ids = new Set(branch.map((entry) => entry.id));
  const unavailable = branch.some(
    (entry) =>
      (entry.parentId !== null && !ids.has(entry.parentId)) ||
      entry.type === "branch_summary" ||
      (entry.type === "compaction" && !ids.has(entry.firstKeptEntryId)),
  );
  return unavailable
    ? "History incomplete: original instructions behind missing entries or branch summaries are unavailable; generated summaries do not restore authorization."
    : "History coverage: available active-branch entries only. Legacy user-input origin is not recorded. Omission markers mean authorization evidence is incomplete.";
}
