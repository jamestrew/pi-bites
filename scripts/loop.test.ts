import { describe, expect, it } from "vitest";
import {
  parseRunOptions,
  pullRequestBodyAfterReview,
  pullRequestReference,
  reviewFindings,
  reviewReport,
  runCaptured,
  selectCandidates,
  shouldMergePullRequest,
} from "./loop.ts";

const issue = (
  number: number,
  blockers: ReadonlyArray<{ state: string }> = [],
  pullRequests: ReadonlyArray<{ state: string }> = [],
  state = "OPEN",
) => ({
  number,
  title: `Issue ${number}`,
  url: `https://example.test/issues/${number}`,
  state,
  blockedBy: { nodes: blockers },
  closedByPullRequestsReferences: pullRequests,
});

describe("run options", () => {
  it("defaults to sequential execution and accepts positive overrides", () => {
    expect(parseRunOptions([])).toMatchObject({ issueLimit: 3, issues: [], jobs: 1 });
    expect(parseRunOptions(["--jobs", "2", "--limit", "7"])).toMatchObject({
      issueLimit: 7,
      issues: [],
      jobs: 2,
    });
    expect(() => parseRunOptions(["--jobs", "0"])).toThrow("positive integer");
  });

  it("takes an explicit issue list and lets it set the limit", () => {
    expect(parseRunOptions(["--issues", "12,#7, 12 ,9"])).toMatchObject({
      issueLimit: 3,
      issues: [12, 7, 9],
      jobs: 1,
    });
    expect(parseRunOptions(["--issues", "12,7", "--limit", "1"]).issueLimit).toBe(1);
    expect(() => parseRunOptions(["--issues", "12,x"])).toThrow("positive integer");
  });

  it("keeps extension snapshots configurable", () => {
    expect(
      parseRunOptions([
        "--extension-runtime",
        "/tmp/pi-extension",
        "--extension-ref",
        "@-",
        "--no-extension-snapshot",
      ]),
    ).toMatchObject({
      extensionRef: "@-",
      extensionRuntime: "/tmp/pi-extension",
      extensionSnapshot: false,
    });
  });
});

describe("ready-for-agent selection", () => {
  it("keeps only unattempted open issues without open blockers or pull requests", () => {
    expect(
      selectCandidates(
        [
          issue(1),
          issue(2, [{ state: "OPEN" }]),
          issue(3, [], [{ state: "OPEN" }]),
          issue(4, [{ state: "CLOSED" }], [{ state: "MERGED" }]),
          issue(5),
          issue(6, [], [], "CLOSED"),
        ],
        new Set([5]),
      ).map(({ number }) => number),
    ).toStrictEqual([1, 4]);
  });
});

describe("pull request lookup", () => {
  it("falls back to a pull request created from a workspace commit", () => {
    expect(
      pullRequestReference([], [{ number: 8, headRefOid: "commit-8" }], new Set(["commit-8"])),
    ).toStrictEqual({ number: 8 });
  });
});

describe("process capture", () => {
  it("stops capturing when the direct child exits", async () => {
    const result = await runCaptured(
      ["sh", "-c", "printf parent-output; (sleep 0.1; printf descendant-output) &"],
      process.cwd(),
    );

    expect(result).toStrictEqual({ exitCode: 0, stdout: "parent-output", stderr: "" });
  });
});

const piOutput = (findings: string) =>
  `Implemented and pushed issue #55.\n\nRALPH_FINDINGS\n${findings}\nRALPH_REVIEW: CHANGES REQUESTED\n`;

describe("review findings", () => {
  it("keeps the marked block and drops the session chatter around it", () => {
    expect(reviewFindings(piOutput("### Blocker — `turn.ts:206` — opens leak"))).toBe(
      "### Blocker — `turn.ts:206` — opens leak",
    );
  });

  it("falls back to the whole output when Pi omits the marker", () => {
    expect(reviewFindings("Fix the race condition.\nRALPH_REVIEW: CHANGES REQUESTED")).toBe(
      "Fix the race condition.",
    );
  });
});

describe("review report", () => {
  it("merges an open pull request after Pi approves the review", () => {
    expect(shouldMergePullRequest("OPEN", "RALPH_REVIEW: APPROVED")).toBe(true);
    expect(shouldMergePullRequest("OPEN", "RALPH_REVIEW: CHANGES REQUESTED")).toBe(false);
    expect(shouldMergePullRequest("MERGED", "RALPH_REVIEW: APPROVED")).toBe(false);
  });

  it("shows the decision and preserves failed-review findings", () => {
    expect(reviewReport("OPEN", "RALPH_REVIEW: APPROVED")).toContain("approved");
    expect(reviewReport("OPEN", "Fix the race condition.")).toContain("Fix the race condition.");
  });

  it("always links the issue and adds requested changes under one heading", () => {
    const output = piOutput("- Fix the race condition.\n- Reject stale answers.");
    const body = pullRequestBodyAfterReview(55, "OPEN", "", output);

    expect(body).toContain("Closes #55");
    expect(body).toContain("- Fix the race condition.\n- Reject stale answers.");
    expect(body).not.toContain("RALPH_");
    expect(pullRequestBodyAfterReview(55, "OPEN", body, output)).toBe(body);
    expect(pullRequestBodyAfterReview(55, "OPEN", "Closes #55", "RALPH_REVIEW: APPROVED")).toBe(
      "Closes #55",
    );
  });

  it("replaces a stale findings section rather than stacking a second one", () => {
    const stale = "Summary.\n\nCloses #55\n\n## Outstanding review findings\n\n- Old finding.\n";
    const body = pullRequestBodyAfterReview(55, "OPEN", stale, piOutput("- New finding."));

    expect(body).toBe(
      "Summary.\n\nCloses #55\n\n## Outstanding review findings\n\n- New finding.\n",
    );
  });
});
