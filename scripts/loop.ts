#!/usr/bin/env bun
import { $ } from "bun";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

const IMPLEMENT_SKILL = "/home/jt/.agents/skills/implement/SKILL.md";
const EXTENSION_WORKSPACE = "pi-bites-agent-extension-runtime";
const DEFAULT_EXTENSION_RUNTIME = join(homedir(), ".cache/pi-bites-agent-extension");
const DEFAULT_EXTENSION_REF = "master@origin";

type NodeList<T> = ReadonlyArray<T> | { readonly nodes: ReadonlyArray<T> };

type Issue = {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly state: string;
  readonly blockedBy: NodeList<{ readonly state: string }>;
  readonly closedByPullRequestsReferences: NodeList<{ readonly state: string }>;
};

type ListedIssue = Omit<Issue, "closedByPullRequestsReferences"> & {
  readonly closedByPullRequestsReferences: NodeList<{ readonly number: number }>;
};

const nodes = <T>(value: NodeList<T>): ReadonlyArray<T> => ("nodes" in value ? value.nodes : value);

const USAGE = `Usage: loop.ts [options]

Options:
  --limit N                    Maximum issues to process (default: 3)
  --jobs N                     Issues to run in parallel (default: 1)
  --issues N,N,...             Process explicit issue numbers
  --work-base-ref REV          Revision to use as the issue workspace base (default: <pr-base>@origin)
  --pr-base BRANCH             Intended PR target (required with --work-base-ref)
  --extension-runtime PATH     Stable extension snapshot directory
  --extension-ref REV          jj revision to snapshot (default: master@origin)
  --no-extension-snapshot      Use pi's normal extension loading`;

const positiveInteger = (option: string, raw: string): number => {
  const value = Number(raw.trim().replace(/^#/, ""));
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${option} must be a positive integer`);
  }
  return value;
};

type RunOptions = {
  readonly workBaseRef: string | undefined;
  readonly prBase: string | undefined;
  readonly extensionRef: string;
  readonly extensionRuntime: string;
  readonly extensionSnapshot: boolean;
  readonly issueLimit: number;
  readonly issues: ReadonlyArray<number>;
  readonly jobs: number;
};

export function parseRunOptions(argv: ReadonlyArray<string>): RunOptions {
  let issueLimit: number | undefined;
  let workBaseRef: string | undefined;
  let prBase: string | undefined;
  let jobs = 1;
  let issues: ReadonlyArray<number> = [];
  let extensionRuntime = DEFAULT_EXTENSION_RUNTIME;
  let extensionRef = DEFAULT_EXTENSION_REF;
  let extensionSnapshot = true;
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index] as string;
    if (option === "--no-extension-snapshot") {
      extensionSnapshot = false;
      continue;
    }
    const raw = argv[++index];
    if (!raw) throw new Error(USAGE);
    if (option === "--issues") {
      issues = [...new Set(raw.split(",").map((part) => positiveInteger(option, part)))];
    } else if (option === "--limit") {
      issueLimit = positiveInteger(option, raw);
    } else if (option === "--jobs") {
      jobs = positiveInteger(option, raw);
    } else if (option === "--work-base-ref") {
      workBaseRef = raw;
    } else if (option === "--pr-base") {
      prBase = raw;
    } else if (option === "--extension-runtime") {
      extensionRuntime = raw;
    } else if (option === "--extension-ref") {
      extensionRef = raw;
    } else {
      throw new Error(USAGE);
    }
  }
  return {
    workBaseRef,
    prBase,
    extensionRef,
    extensionRuntime,
    extensionSnapshot,
    issueLimit: issueLimit ?? (issues.length || 3),
    issues,
    jobs,
  };
}

const referencesIssue = (pr: Pick<PullRequest, "body">, issueNumber: number): boolean =>
  pr.body.split("\n").some((line) => line.trim() === `Closes #${issueNumber}`);

export const selectCandidates = (
  issues: ReadonlyArray<Issue>,
  attempted: ReadonlySet<number>,
  openPullRequests: ReadonlyArray<Pick<PullRequest, "body">> = [],
): Array<Issue> =>
  issues.filter(
    (issue) =>
      !attempted.has(issue.number) &&
      issue.state === "OPEN" &&
      !openPullRequests.some((pr) => referencesIssue(pr, issue.number)) &&
      nodes(issue.blockedBy).every((blocker) => blocker.state === "CLOSED") &&
      nodes(issue.closedByPullRequestsReferences).every((pr) => pr.state !== "OPEN"),
  );

type PullRequest = {
  readonly number: number;
  readonly state: string;
  readonly baseRefName: string;
  readonly headRefName: string;
  readonly headRefOid: string;
  readonly isCrossRepository: boolean;
  readonly body: string;
  readonly url: string;
};

export function targetBranch(
  options: Pick<RunOptions, "workBaseRef" | "prBase">,
  defaultBranch: string,
): string {
  if (options.workBaseRef && !options.prBase) {
    throw new Error(
      "--work-base-ref requires --pr-base: revisions do not identify a PR target branch",
    );
  }
  return options.prBase ?? defaultBranch;
}

export function reviewVerdict(output: string) {
  // Only one terminal verdict is accepted; quoted approvals and earlier review rounds are not authority.
  const lines = output.trimEnd().split("\n");
  const verdicts = lines.filter((line) => line.startsWith("RALPH_REVIEW:"));
  if (verdicts.length !== 1) return undefined;
  const match =
    /^RALPH_REVIEW: (APPROVED|CHANGES REQUESTED) PR #([1-9][0-9]*) HEAD ([a-f0-9]{40})$/.exec(
      lines.at(-1) ?? "",
    );
  return match
    ? { approved: match[1] === "APPROVED", number: Number(match[2]), headRefOid: match[3] }
    : undefined;
}

export async function workspaceChangeIds(
  workspacePath: string,
  startingBase: string,
  preexisting: ReadonlySet<string>,
): Promise<ReadonlySet<string>> {
  const commitIds =
    await $`jj -R ${workspacePath} log -r ${`${startingBase}::@ ~ ${startingBase}`} --no-graph -T ${'commit_id ++ "\\n"'}`.text();
  return new Set(
    commitIds
      .trim()
      .split("\n")
      .filter((id) => id && !preexisting.has(id)),
  );
}

export function pullRequestReference(
  pullRequests: ReadonlyArray<PullRequest>,
  issueNumber: number,
  base: string,
  newWorkspaceCommitIds: ReadonlySet<string>,
  piOutput: string,
  protectedBranches: ReadonlySet<string> = new Set(),
): PullRequest {
  const matches = pullRequests.filter(
    (pr) =>
      pr.state === "OPEN" &&
      pr.baseRefName === base &&
      pr.isCrossRepository === false &&
      pr.headRefName !== base &&
      !protectedBranches.has(pr.headRefName) &&
      newWorkspaceCommitIds.has(pr.headRefOid) &&
      referencesIssue(pr, issueNumber),
  );
  if (matches.length !== 1)
    throw new Error(
      `Issue #${issueNumber}: expected exactly one new OPEN PR targeting ${base}, found ${matches.length}`,
    );
  const pr = matches[0]!;
  const verdict = reviewVerdict(piOutput);
  if (!verdict || verdict.number !== pr.number || verdict.headRefOid !== pr.headRefOid) {
    throw new Error(`Review does not identify PR #${pr.number} at its current head`);
  }
  return pr;
}

const reviewApproved = (state: string, piOutput: string): boolean =>
  state === "MERGED" || reviewVerdict(piOutput)?.approved === true;

export const shouldMergePullRequest = (state: string, piOutput: string): boolean =>
  state === "OPEN" && reviewApproved(state, piOutput);

export function verifyMergedPullRequest(expected: PullRequest, actual: PullRequest): void {
  if (
    actual.state !== "MERGED" ||
    actual.number !== expected.number ||
    actual.baseRefName !== expected.baseRefName ||
    actual.headRefOid !== expected.headRefOid ||
    actual.headRefName !== expected.headRefName ||
    actual.isCrossRepository !== false
  ) {
    throw new Error(
      `PR #${expected.number}: merge identity or target changed; refusing cleanup and issue closure`,
    );
  }
}

export const canDeleteBranch = (pr: PullRequest, protectedBranches: ReadonlySet<string>): boolean =>
  pr.state === "MERGED" && pr.isCrossRepository === false && !protectedBranches.has(pr.headRefName);

const FINDINGS_HEADING = "## Outstanding review findings";
const FINDINGS_MARKER = "RALPH_FINDINGS";
const VERDICT_LINE = /^RALPH_REVIEW: .*$/m;

/** The findings block Pi emits between its marker and its verdict, free of session chatter. */
export function reviewFindings(piOutput: string): string {
  const marker = piOutput.lastIndexOf(FINDINGS_MARKER);
  const tail = marker === -1 ? piOutput : piOutput.slice(marker + FINDINGS_MARKER.length);
  const verdict = tail.search(VERDICT_LINE);
  return (verdict === -1 ? tail : tail.slice(0, verdict)).trim();
}

export function reviewReport(state: string, piOutput: string): string {
  if (reviewApproved(state, piOutput)) {
    return `Review approved; pull request is ${state.toLowerCase()}.`;
  }
  return `Review not approved; pull request is ${state.toLowerCase()}.\n\nReview findings:\n${reviewFindings(piOutput) || "Pi returned no review details."}`;
}

export function pullRequestBodyAfterReview(
  issueNumber: number,
  state: string,
  currentBody: string,
  piOutput: string,
): string {
  const authored = currentBody.split(FINDINGS_HEADING)[0]?.trimEnd() ?? "";
  const closingReference = `Closes #${issueNumber}`;
  const body = authored.includes(closingReference)
    ? authored
    : `${authored}${authored.trim() ? "\n\n" : ""}${closingReference}`;
  const findings = reviewFindings(piOutput);
  if (reviewApproved(state, piOutput) || !findings) {
    return body;
  }
  return `${body}\n\n${FINDINGS_HEADING}\n\n${findings}\n`;
}

async function deleteMergedBranch(
  workspacePath: string,
  repo: string,
  pullRequest: PullRequest,
  protectedBranches: ReadonlySet<string>,
): Promise<void> {
  if (!canDeleteBranch(pullRequest, protectedBranches)) return;
  const branch = pullRequest.headRefName;
  // A lease prevents deleting a branch advanced since the reviewed head was merged.
  const gitDirectory = (await $`jj -R ${workspacePath} git root`.text()).trim();
  const remote = (await $`git --git-dir ${gitDirectory} remote get-url origin`.text()).trim();
  const remoteRepo = (
    await $`gh repo view ${remote} --json nameWithOwner --jq .nameWithOwner`.text()
  ).trim();
  if (remoteRepo.toLowerCase() !== repo.toLowerCase()) {
    throw new Error("Origin does not identify the merged PR repository; refusing branch deletion");
  }
  const remoteRef = `refs/heads/${branch}`;
  const exists = (
    await $`git --git-dir ${gitDirectory} ls-remote --refs ${remote} ${remoteRef}`.text()
  ).trim();
  if (exists) {
    await $`git --git-dir ${gitDirectory} push ${remote} ${`--force-with-lease=${remoteRef}:${pullRequest.headRefOid}`} ${`:${remoteRef}`}`.quiet();
  }
  const local = (
    await $`jj -R ${workspacePath} bookmark list ${`exact:${branch}`} -T ${"if(!remote, normal_target.commit_id())"}`.text()
  ).trim();
  if (local === pullRequest.headRefOid) {
    await $`jj -R ${workspacePath} bookmark delete ${`exact:${branch}`}`.quiet();
  }
  console.log(`Deleted branch: ${branch}`);
}

const ISSUE_FIELDS = "number,title,url,state,blockedBy,closedByPullRequestsReferences";

async function listIssues(
  repo: string,
  requested: ReadonlyArray<number>,
): Promise<ReadonlyArray<ListedIssue>> {
  if (requested.length === 0) {
    return JSON.parse(
      await $`gh issue list -R ${repo} --state open --label ready-for-agent --limit 1000 --json ${ISSUE_FIELDS}`.text(),
    ) as ReadonlyArray<ListedIssue>;
  }
  return Promise.all(
    requested.map(async (number) => {
      const view = await $`gh issue view ${number} -R ${repo} --json ${ISSUE_FIELDS}`
        .quiet()
        .nothrow();
      if (view.exitCode !== 0) {
        throw new Error(
          `Cannot read issue #${number} in ${repo}: ${view.stderr.toString().trim() || `gh exited with status ${view.exitCode}`}`,
        );
      }
      return JSON.parse(view.stdout.toString()) as ListedIssue;
    }),
  );
}

const PR_FIELDS = "number,state,url,body,headRefOid,headRefName,baseRefName,isCrossRepository";

async function readPullRequest(repo: string, number: number): Promise<PullRequest> {
  return JSON.parse(await $`gh pr view ${number} -R ${repo} --json ${PR_FIELDS}`.text());
}

async function listOpenPullRequests(repo: string, base: string): Promise<PullRequest[]> {
  // Closing links are absent on non-default bases; inspect all open PRs on the intended base.
  const pages = JSON.parse(
    await $`gh api --paginate ${`repos/${repo}/pulls?state=open&base=${encodeURIComponent(base)}&per_page=100`} --slurp`.text(),
  ) as Array<Array<{ number: number }>>;
  return Promise.all(pages.flat().map(({ number }) => readPullRequest(repo, number)));
}

const implementPrompt = (
  repo: string,
  reviewBase: string,
  prBase: string,
  issueNumber: number,
): string =>
  `/skill:implement Implement ${issueNumber} in ${repo}.

This is an unattended, non-interactive run: no user is available to answer questions. Proceed with reasonable assumptions grounded in the issue and repository, and record consequential assumptions in your final response before the findings block. For this run, choose appropriate existing test seams without user confirmation; this overrides skills' requirements to ask for seam approval. Do not stop to request clarification or approval. If a genuine blocker prevents safe completion, report the blocker and what is needed to proceed instead of asking a question; do not fabricate a PR or review verdict.

Use ${reviewBase} as the review base. This is a jj-backed repository, so prefer jj for version-control operations.

After the skill's implementation and review cycle, push the change and open a pull request targeting exactly ${prBase} (gh pr create --base ${prBase}). Do not merge, close issues, or delete branches yourself. Review the final pushed head, and report that exact PR number and full 40-character head commit ID below.

# Pull request body

Write exactly this shape and no other headings:

> One paragraph, present tense, saying what the change does in the repository's own domain words.
>
> A second paragraph only when the reader needs the reason the change looks the way it does — a root cause, a constraint that forced the shape, or an obvious alternative you rejected and why.
>
> ## Verification
>
> - one backticked command per line, exactly as you ran it
>
> Closes #${issueNumber}

The body stops at that line. The runner appends any outstanding findings itself.

# Outcome

When the final review round approved: leave the pull request open. The runner merges with rebase semantics and deletes the local and remote branch.

When the third round still requests changes: leave the pull request open for human review and report the findings it left standing.

# Findings

Report every finding the third round raised, plus every earlier finding you declined that the reviewer did not withdraw. Write each one as:

### <Blocker|Risk|Nit> — \`path/to/file.ts:42\` — short claim in a clause

- **What** — the mechanism: the code path, and the condition under which it misbehaves. Name the symbols involved.
- **Impact** — what someone observes when it bites, and how often.
- **Fix** — the change the reviewer asked for, concrete enough to act on without re-reading the diff.
- **Status** — why it is still open: declined, with your reason; or unresolved when the three rounds ran out.

A Blocker is a finding the reviewer would withhold approval over; a Risk is a hazard they flagged but would ship; a Nit is neither. Point the location at the file a reader should open first, even when the finding spans several.

# Final response

End with the findings block, then the verdict, and nothing after it:

RALPH_FINDINGS
<the findings, or nothing when the review approved>
RALPH_REVIEW: APPROVED PR #<number> HEAD <full commit ID>

The last line uses APPROVED or CHANGES REQUESTED, followed by the exact PR number and reviewed HEAD as shown. Emit only one RALPH_REVIEW line.`;

async function prepareExtensionRuntime(options: RunOptions): Promise<ReadonlyArray<string>> {
  if (!options.extensionSnapshot) return ["--approve", "--yolo"];

  console.log(
    `Preparing stable pi extension runtime: ${options.extensionRuntime} (${options.extensionRef})`,
  );
  await $`jj workspace forget ${EXTENSION_WORKSPACE}`.quiet().nothrow();
  await rm(options.extensionRuntime, { recursive: true, force: true });
  await $`jj workspace add --name ${EXTENSION_WORKSPACE} --revision ${options.extensionRef} ${options.extensionRuntime}`;
  await $`bun install --frozen-lockfile`.cwd(options.extensionRuntime);
  await $`bun check`.cwd(options.extensionRuntime);
  const extension = join(options.extensionRuntime, "packages/ext/index.ts");
  return ["-n", "-e", extension, "--approve", "--yolo"];
}

export async function runCaptured(
  command: ReadonlyArray<string>,
  cwd: string,
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
  // Regular files cannot be held open in a way that delays reading when an agent leaves a descendant running.
  const outputDirectory = await mkdtemp(join(tmpdir(), "pi-bites-pi-"));
  const stdoutPath = join(outputDirectory, "stdout");
  const stderrPath = join(outputDirectory, "stderr");
  try {
    const child = Bun.spawn([...command], {
      cwd,
      stdout: Bun.file(stdoutPath),
      stderr: Bun.file(stderrPath),
    });
    const exitCode = await child.exited;
    const [stdout, stderr] = await Promise.all([
      Bun.file(stdoutPath).text(),
      Bun.file(stderrPath).text(),
    ]);
    return { exitCode, stdout, stderr };
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
}

async function runPi(
  cwd: string,
  piArgs: ReadonlyArray<string>,
  name: string,
  prompt: string,
): Promise<string> {
  console.log(`${name}: Pi working...`);

  const {
    exitCode,
    stdout: output,
    stderr: errors,
  } = await runCaptured(
    ["pi", ...piArgs, "--print", "--name", name, "--skill", IMPLEMENT_SKILL, prompt],
    cwd,
  );
  if (exitCode !== 0) {
    throw new Error(
      [errors.trim() || `Pi exited with status ${exitCode}`, output.trim()]
        .filter(Boolean)
        .join("\n"),
    );
  }
  console.log(`${name}: Pi done.`);
  return output;
}

async function main() {
  const options = parseRunOptions(process.argv.slice(2));
  const { issueLimit, issues: requestedIssues, jobs } = options;
  for (const command of ["bun", "gh", "git", "jj", "pi"]) {
    if (!Bun.which(command)) throw new Error(`Missing required command: ${command}`);
  }
  if (!(await Bun.file(IMPLEMENT_SKILL).exists())) {
    throw new Error(`Missing implement skill: ${IMPLEMENT_SKILL}`);
  }
  const repository = JSON.parse(
    await $`gh repo view --json nameWithOwner,defaultBranchRef`.text(),
  ) as { nameWithOwner: string; defaultBranchRef: { name: string } };
  const repo = repository.nameWithOwner;
  const base = targetBranch(options, repository.defaultBranchRef.name);
  const workBaseRef = options.workBaseRef ?? `${base}@origin`;
  const protectedBranches = new Set([
    base,
    repository.defaultBranchRef.name,
    workBaseRef.replace(/@origin$/, ""),
    options.extensionRef.replace(/@origin$/, ""),
  ]);
  // Validate the branch independently of the arbitrary jj workspace revision.
  await $`gh api ${`repos/${repo}/branches/${encodeURIComponent(base)}`}`.quiet();
  await $`jj git fetch --remote origin`.quiet();
  for (const name of (await $`jj bookmark list --all-remotes -T ${'name ++ "\\n"'}`.text())
    .trim()
    .split("\n")) {
    protectedBranches.add(name);
  }
  const piArgs = await prepareExtensionRuntime(options);
  const repoRoot = (await $`jj workspace root`.text()).trim();
  const workspaceParent = join(dirname(repoRoot), `.${basename(repoRoot)}-workspaces`);
  const attempted = new Set<number>();
  const reported = new Set<number>();

  for (;;) {
    if (attempted.size >= issueLimit) break;
    await $`jj git fetch --remote origin`.quiet();
    const listedIssues = await listIssues(repo, requestedIssues);
    const issues = await Promise.all(
      listedIssues.map(
        async (issue): Promise<Issue> => ({
          ...issue,
          closedByPullRequestsReferences: await Promise.all(
            nodes(issue.closedByPullRequestsReferences).map(async ({ number }) => ({
              state: (
                await $`gh pr view ${number} -R ${repo} --json state --jq .state`.text()
              ).trim(),
            })),
          ),
        }),
      ),
    );
    const openPullRequests = await listOpenPullRequests(repo, base);
    const eligible = selectCandidates(issues, attempted, openPullRequests).sort(
      (left, right) => left.number - right.number,
    );
    const skipped = requestedIssues.filter(
      (number) =>
        !attempted.has(number) &&
        !reported.has(number) &&
        !eligible.some((issue) => issue.number === number),
    );
    if (skipped.length > 0) {
      for (const number of skipped) reported.add(number);
      console.log(
        `Skipped ineligible issue(s): ${skipped.map((number) => `#${number}`).join(", ")}`,
      );
    }
    const candidates = eligible.slice(0, Math.min(jobs, issueLimit - attempted.size));
    if (candidates.length === 0) break;

    const parent = (
      await $`jj log -r ${workBaseRef} --no-graph -T ${'commit_id.short(12) ++ " " ++ description.first_line()'}`.text()
    ).trim();
    for (const issue of candidates) attempted.add(issue.number);
    const results = await Promise.allSettled(
      candidates.map(async (issue) => {
        console.log(`\nIssue #${issue.number}: ${issue.title}`);
        console.log(issue.url);
        console.log(`Parent: ${parent}`);

        const workspaceName = `${issue.number}-${process.pid}`;
        const workspacePath = join(workspaceParent, workspaceName);
        await mkdir(workspaceParent, { recursive: true });
        const startingBase = (
          await $`jj log -r ${workBaseRef} --no-graph -T commit_id`.text()
        ).trim();
        if (!/^[a-f0-9]{40}$/.test(startingBase))
          throw new Error("Workspace base must resolve to one commit");
        const preexisting = new Set(
          (await $`jj log -r ${"all()"} --no-graph -T ${'commit_id ++ "\\n"'}`.text())
            .trim()
            .split("\n"),
        );
        await $`jj workspace add --name ${workspaceName} -r ${startingBase} ${workspacePath}`.quiet();

        let finished = false;
        try {
          if (existsSync(join(repoRoot, "node_modules"))) {
            await symlink(
              join(repoRoot, "node_modules"),
              join(workspacePath, "node_modules"),
              "dir",
            );
          }
          const piOutput = await runPi(
            workspacePath,
            piArgs,
            `issue #${issue.number}`,
            implementPrompt(repo, startingBase, base, issue.number),
          );

          const newWorkspaceCommitIds = await workspaceChangeIds(
            workspacePath,
            startingBase,
            preexisting,
          );
          const identified = pullRequestReference(
            await listOpenPullRequests(repo, base),
            issue.number,
            base,
            newWorkspaceCommitIds,
            piOutput,
            protectedBranches,
          );
          // Revalidate fresh metadata before the first mutation. The merge also has a head lease.
          const pullRequest = pullRequestReference(
            [await readPullRequest(repo, identified.number)],
            issue.number,
            base,
            newWorkspaceCommitIds,
            piOutput,
            protectedBranches,
          );
          const updatedBody = pullRequestBodyAfterReview(
            issue.number,
            pullRequest.state,
            pullRequest.body,
            piOutput,
          );
          if (updatedBody !== pullRequest.body) {
            await $`gh pr edit ${pullRequest.number} -R ${repo} --body ${updatedBody}`.quiet();
          }

          console.log(`Pull request #${pullRequest.number}: ${pullRequest.url}`);
          console.log(reviewReport(pullRequest.state, piOutput));
          if (shouldMergePullRequest(pullRequest.state, piOutput)) {
            pullRequestReference(
              [await readPullRequest(repo, pullRequest.number)],
              issue.number,
              base,
              newWorkspaceCommitIds,
              piOutput,
              protectedBranches,
            );
            await $`gh pr merge ${pullRequest.number} -R ${repo} --rebase --match-head-commit ${pullRequest.headRefOid}`.quiet();
            const merged = await readPullRequest(repo, pullRequest.number);
            verifyMergedPullRequest(pullRequest, merged);
            console.log(`Merged pull request #${pullRequest.number}.`);
            if (base !== repository.defaultBranchRef.name) {
              await $`gh issue close ${issue.number} -R ${repo}`.quiet();
            }
            await deleteMergedBranch(workspacePath, repo, merged, protectedBranches);
          }
          finished = true;
        } finally {
          if (finished) {
            try {
              await $`jj workspace forget ${workspaceName}`.quiet();
            } finally {
              await rm(workspacePath, { recursive: true, force: true });
            }
            console.log(`Deleted workspace: ${workspacePath}`);
          } else {
            console.error(`Workspace preserved for recovery: ${workspacePath}`);
          }
        }
      }),
    );
    const failures: Array<unknown> = [];
    for (const result of results) {
      if (result.status === "rejected") failures.push(result.reason);
    }
    if (failures.length > 0) {
      throw new Error(
        failures
          .map((error) => (error instanceof Error ? error.message : String(error)))
          .join("\n\n"),
      );
    }
  }

  console.log(`\nProcessed ${attempted.size} issue(s).`);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
