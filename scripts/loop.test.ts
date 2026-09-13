import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  workspaceChangeIds,
  canDeleteBranch,
  targetBranch,
  verifyMergedPullRequest,
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

  it("keeps the issue workspace base independent from the extension revision", () => {
    expect(parseRunOptions(["--work-base-ref", "subagents-codex@origin"])).toMatchObject({
      workBaseRef: "subagents-codex@origin",
      extensionRef: "master@origin",
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

const head = "a".repeat(40);
const approval = `RALPH_REVIEW: APPROVED PR #311 HEAD ${head}`;
const pr = (changes = {}) => ({
  number: 311,
  state: "OPEN",
  baseRefName: "subagents-codex",
  headRefName: "issue-305",
  headRefOid: head,
  isCrossRepository: false,
  body: "Implementation.\n\nCloses #305",
  url: "https://example.test/pull/311",
  ...changes,
});
const identify = (prs: ReturnType<typeof pr>[], output = approval) =>
  pullRequestReference(prs, 305, "subagents-codex", new Set([head]), output);

it("skips an issue whose integration PR is open without GitHub closing links", () => {
  expect(
    selectCandidates([issue(305), issue(306)], new Set(), [pr()]).map((i) => i.number),
  ).toEqual([306]);
});

describe("pull request identity", () => {
  it("requires an explicit target for arbitrary work revisions and preserves the default", () => {
    expect(targetBranch(parseRunOptions([]), "master")).toBe("master");
    expect(() =>
      targetBranch(parseRunOptions(["--work-base-ref", "subagents-codex"]), "master"),
    ).toThrow("--pr-base");
    expect(
      targetBranch(
        parseRunOptions(["--work-base-ref", "@-", "--pr-base", "subagents-codex"]),
        "master",
      ),
    ).toBe("subagents-codex");
  });

  it("rejects foundation PR303 and accepts PR311 without GitHub closing links", () => {
    const foundation = pr({
      number: 303,
      baseRefName: "master",
      headRefName: "subagents-codex",
      headRefOid: "b".repeat(40),
      body: "Closes #302",
    });
    expect(() => identify([foundation], "RALPH_REVIEW: APPROVED")).toThrow();
    expect(identify([foundation, pr()]).number).toBe(311);
    expect(
      pullRequestReference(
        [pr({ baseRefName: "master" })],
        305,
        "master",
        new Set([head]),
        approval,
      ).number,
    ).toBe(311);
  });

  it("rejects a preexisting runtime branch even if the agent moved and approved its head", () => {
    expect(() =>
      pullRequestReference(
        [pr({ headRefName: "codex-code-mode" })],
        305,
        "subagents-codex",
        new Set([head]),
        approval,
        new Set(["codex-code-mode"]),
      ),
    ).toThrow("exactly one");
  });

  it("fails closed on ambiguous issue PRs even when the verdict names one", () => {
    expect(() => identify([pr(), pr({ number: 312 })])).toThrow("exactly one");
  });

  it.each([
    { state: "MERGED" },
    { state: "CLOSED" },
    { baseRefName: "master" },
    { headRefOid: "b".repeat(40) },
    { body: "Closes #3050" },
    { body: "Mentions #305" },
    { isCrossRepository: true },
    { headRefName: "subagents-codex" },
  ])("rejects unvalidated metadata %j", (changes) => {
    expect(() => identify([pr(changes)])).toThrow();
  });

  it.each([
    "RALPH_REVIEW: APPROVED",
    `quoted ${approval}`,
    `${approval}\nmore output`,
    `${approval}\n${approval}`,
    approval.replace("#311", "#303"),
    approval.replace(head, "b".repeat(40)),
  ])("does not reuse an unrelated or stale approval: %s", (output) => {
    expect(() => identify([pr()], output)).toThrow();
  });

  it("accepts an identity-bound request for changes without merging", () => {
    const output = approval.replace("APPROVED", "CHANGES REQUESTED");
    expect(identify([pr()], output).number).toBe(311);
    expect(shouldMergePullRequest("OPEN", output)).toBe(false);
  });

  it("verifies the merged identity before closure or cleanup and protects existing branches", () => {
    const merged = pr({ state: "MERGED" });
    expect(() => verifyMergedPullRequest(pr(), merged)).not.toThrow();
    for (const changes of [
      { state: "OPEN" },
      { baseRefName: "master" },
      { headRefOid: "b".repeat(40) },
      { number: 303 },
      { headRefName: "master" },
      { isCrossRepository: true },
    ]) {
      expect(() => verifyMergedPullRequest(pr(), { ...merged, ...changes })).toThrow();
    }
    expect(canDeleteBranch(merged, new Set(["issue-305"]))).toBe(false);
    expect(canDeleteBranch(merged, new Set(["subagents-codex", "master", "runtime"]))).toBe(true);
    expect(canDeleteBranch(pr(), new Set())).toBe(false);
    for (const branch of ["subagents-codex", "master", "runtime"]) {
      expect(
        canDeleteBranch(
          { ...merged, headRefName: branch },
          new Set(["subagents-codex", "master", "runtime"]),
        ),
      ).toBe(false);
    }
  });
});

it("excludes PR303's foundation and preexisting heads from actual jj workspace history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "loop-provenance-"));
  const jj = async (...args: string[]) => {
    const result = await runCaptured(
      [
        "jj",
        "--config",
        "user.name=Loop Test",
        "--config",
        "user.email=loop@example.test",
        ...args,
      ],
      directory,
    );
    expect(result.exitCode, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  try {
    await jj("git", "init");
    await jj("describe", "-m", "foundation PR303");
    const startingBase = await jj("log", "-r", "@", "--no-graph", "-T", "commit_id");
    await jj("new", "-m", "preexisting descendant");
    const oldHead = await jj("log", "-r", "@", "--no-graph", "-T", "commit_id");
    const preexisting = new Set([startingBase, oldHead]);
    expect(await workspaceChangeIds(directory, startingBase, preexisting)).toEqual(new Set());
    await jj("new", "-m", "issue305 PR311");
    const newHead = await jj("log", "-r", "@", "--no-graph", "-T", "commit_id");
    expect(await workspaceChangeIds(directory, startingBase, preexisting)).toEqual(
      new Set([newHead]),
    );
    await jj("new", "root()", "-m", "unrelated new work");
    expect(await workspaceChangeIds(directory, startingBase, preexisting)).toEqual(new Set());
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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
    expect(shouldMergePullRequest("OPEN", approval)).toBe(true);
    expect(shouldMergePullRequest("OPEN", "RALPH_REVIEW: CHANGES REQUESTED")).toBe(false);
    expect(shouldMergePullRequest("MERGED", approval)).toBe(false);
  });

  it("shows the decision and preserves failed-review findings", () => {
    expect(reviewReport("OPEN", approval)).toContain("approved");
    expect(reviewReport("OPEN", "Fix the race condition.")).toContain("Fix the race condition.");
  });

  it("always links the issue and adds requested changes under one heading", () => {
    const output = piOutput("- Fix the race condition.\n- Reject stale answers.");
    const body = pullRequestBodyAfterReview(55, "OPEN", "", output);

    expect(body).toContain("Closes #55");
    expect(body).toContain("- Fix the race condition.\n- Reject stale answers.");
    expect(body).not.toContain("RALPH_");
    expect(pullRequestBodyAfterReview(55, "OPEN", body, output)).toBe(body);
    expect(pullRequestBodyAfterReview(55, "OPEN", "Closes #55", approval)).toBe("Closes #55");
  });

  it("replaces a stale findings section rather than stacking a second one", () => {
    const stale = "Summary.\n\nCloses #55\n\n## Outstanding review findings\n\n- Old finding.\n";
    const body = pullRequestBodyAfterReview(55, "OPEN", stale, piOutput("- New finding."));

    expect(body).toBe(
      "Summary.\n\nCloses #55\n\n## Outstanding review findings\n\n- New finding.\n",
    );
  });
});
