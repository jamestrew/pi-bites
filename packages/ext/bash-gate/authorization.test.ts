import { describe, expect, test, vi } from "vitest";
import { ShellAuthorizationTransactions } from "./authorization.js";

function harness() {
  const appendEntry = vi.fn();
  const transactions = new ShellAuthorizationTransactions({ appendEntry });
  transactions.sessionStarted();
  return { appendEntry, transactions };
}

describe("ShellAuthorizationTransactions", () => {
  test("derives persistence and enforcement from one allow or block decision", () => {
    const { appendEntry, transactions } = harness();
    const allowed = transactions.begin({
      version: 1,
      toolCallId: "allow-call",
      toolName: "bash",
      command: "rm generated.txt",
    });
    const blocked = transactions.begin({
      version: 1,
      toolCallId: "block-call",
      toolName: "exec_command",
      command: "rm protected.txt",
    });

    expect(allowed.complete({ outcome: "allow", authorization: "human-approved" })).toBeUndefined();
    expect(blocked.complete({ outcome: "block", reason: "Denied" })).toEqual({
      block: true,
      reason: "Denied",
    });
    expect(appendEntry.mock.calls.map(([, entry]) => entry.status)).toEqual([
      "human-approved",
      "blocked",
    ]);
  });

  test("persists pending work as blocked once when its owning session ends", () => {
    const { appendEntry, transactions } = harness();
    const pending = transactions.begin({
      version: 1,
      toolCallId: "pending-call",
      toolName: "bash",
      command: "deploy production",
    });

    transactions.sessionEnded();
    expect(pending.complete({ outcome: "allow", authorization: "reviewer-approved" })).toEqual({
      block: true,
      reason: "Bash gate: owning session changed before authorization completed.",
    });
    expect(appendEntry).toHaveBeenCalledTimes(1);
    expect(appendEntry).toHaveBeenCalledWith(
      "pi-bites:shell-authorization",
      expect.objectContaining({ status: "blocked" }),
    );
  });
});
