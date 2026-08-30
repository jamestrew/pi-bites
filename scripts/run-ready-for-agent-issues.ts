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

const USAGE = `Usage: run-ready-for-agent-issues.ts [options]

Options:
  --limit N                    Maximum issues to process (default: 3)
  --jobs N                     Issues to run in parallel (default: 1)
  --issues N,N,...             Process explicit issue numbers
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
  readonly extensionRef: string;
  readonly extensionRuntime: string;
  readonly extensionSnapshot: boolean;
  readonly issueLimit: number;
  readonly issues: ReadonlyArray<number>;
  readonly jobs: number;
};

export function parseRunOptions(argv: ReadonlyArray<string>): RunOptions {
  let issueLimit: number | undefined;
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
    } else if (option === "--extension-runtime") {
      extensionRuntime = raw;
    } else if (option === "--extension-ref") {
      extensionRef = raw;
    } else {
      throw new Error(USAGE);
    }
  }
  return {
    extensionRef,
    extensionRuntime,
    extensionSnapshot,
    issueLimit: issueLimit ?? (issues.length || 3),
    issues,
    jobs,
  };
}

export const selectCandidates = (
  issues: ReadonlyArray<Issue>,
  attempted: ReadonlySet<number>,
): Array<Issue> =>
  issues.filter(
    (issue) =>
      !attempted.has(issue.number) &&
      issue.state === "OPEN" &&
      nodes(issue.blockedBy).every((blocker) => blocker.state === "CLOSED") &&
      nodes(issue.closedByPullRequestsReferences).every((pr) => pr.state !== "OPEN"),
  );

export function pullRequestReference(
  linked: ReadonlyArray<{ readonly number: number }>,
  repositoryPullRequests: ReadonlyArray<{ readonly number: number; readonly headRefOid: string }>,
  workspaceCommitIds: ReadonlySet<string>,
): { readonly number: number } | undefined {
  const reference =
    linked.at(-1) ??
    repositoryPullRequests.find((pullRequest) => workspaceCommitIds.has(pullRequest.headRefOid));
  return reference && { number: reference.number };
}

const reviewApproved = (state: string, piOutput: string): boolean =>
  state === "MERGED" || piOutput.includes("RALPH_REVIEW: APPROVED");

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
  pullRequestNumber: number,
): Promise<void> {
  const head = JSON.parse(
    await $`gh pr view ${pullRequestNumber} -R ${repo} --json headRefName,headRepository`.text(),
  ) as { headRefName: string; headRepository: { nameWithOwner: string } };
  const endpoint = `repos/${head.headRepository.nameWithOwner}/git/refs/heads/${head.headRefName}`;
  const remoteBranch = await $`gh api ${endpoint}`.quiet().nothrow();
  if (remoteBranch.exitCode === 0) {
    await $`gh api --method DELETE ${endpoint}`.quiet();
  } else if (!remoteBranch.stderr.toString().includes("HTTP 404")) {
    throw new Error(remoteBranch.stderr.toString().trim());
  }

  const localBookmark = (
    await $`jj -R ${workspacePath} bookmark list ${`exact:${head.headRefName}`} -T name`.text()
  ).trim();
  if (localBookmark === head.headRefName) {
    await $`jj -R ${workspacePath} bookmark delete ${`exact:${head.headRefName}`}`.quiet();
  }
  console.log(`Deleted branch: ${head.headRefName}`);
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

const implementPrompt = (repo: string, base: string, issueNumber: number): string =>
  `/skill:implement Implement ${issueNumber} in ${repo}.

Use ${base}@origin as the review base. This is a jj-backed repository, so prefer jj for version-control operations.

After the skill's implementation and review cycle, push the change and open a pull request.

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

When the final review round approved: merge with rebase semantics, then delete the local and remote branch.

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
RALPH_REVIEW: APPROVED

The last line reads exactly \`RALPH_REVIEW: APPROVED\` or exactly \`RALPH_REVIEW: CHANGES REQUESTED\`.`;

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
  await $`pi -n -e ${extension} --print Say OK`.quiet();
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
  for (const command of ["bun", "gh", "jj", "pi"]) {
    if (!Bun.which(command)) throw new Error(`Missing required command: ${command}`);
  }
  if (!(await Bun.file(IMPLEMENT_SKILL).exists())) {
    throw new Error(`Missing implement skill: ${IMPLEMENT_SKILL}`);
  }
  if ((await $`jj diff --summary`.text()).trim()) {
    throw new Error("Working copy is not clean");
  }

  const repository = JSON.parse(
    await $`gh repo view --json nameWithOwner,defaultBranchRef`.text(),
  ) as { nameWithOwner: string; defaultBranchRef: { name: string } };
  const repo = repository.nameWithOwner;
  const base = repository.defaultBranchRef.name;
  await $`jj git fetch --remote origin`.quiet();
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
    const eligible = selectCandidates(issues, attempted).sort(
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
      await $`jj log -r ${`${base}@origin`} --no-graph -T ${'commit_id.short(12) ++ " " ++ description.first_line()'}`.text()
    ).trim();
    for (const issue of candidates) attempted.add(issue.number);
    const results = await Promise.allSettled(
      candidates.map(async (issue) => {
        console.log(`\nIssue #${issue.number}: ${issue.title}`);
        console.log(issue.url);
        console.log(`Parent: ${parent}`);

        const workspaceName = `issue-${issue.number}-${process.pid}`;
        const workspacePath = join(workspaceParent, workspaceName);
        await mkdir(workspaceParent, { recursive: true });
        await $`jj workspace add --name ${workspaceName} -r ${`${base}@origin`} ${workspacePath}`.quiet();

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
            implementPrompt(repo, base, issue.number),
          );

          const linkedPullRequests = JSON.parse(
            await $`gh issue view ${issue.number} -R ${repo} --json closedByPullRequestsReferences --jq .closedByPullRequestsReferences`.text(),
          ) as ReadonlyArray<{ number: number }>;
          let repositoryPullRequests: ReadonlyArray<{ number: number; headRefOid: string }> = [];
          let workspaceCommitIds = new Set<string>();
          if (linkedPullRequests.length === 0) {
            const commitIds =
              await $`jj -R ${workspacePath} log -r ${`${base}@origin..@`} --no-graph -T ${'commit_id ++ "\\n"'}`.text();
            workspaceCommitIds = new Set(commitIds.trim().split("\n").filter(Boolean));
            repositoryPullRequests = JSON.parse(
              await $`gh pr list -R ${repo} --base ${base} --state all --limit 1000 --json number,headRefOid`.text(),
            ) as ReadonlyArray<{ number: number; headRefOid: string }>;
          }
          const reference = pullRequestReference(
            linkedPullRequests,
            repositoryPullRequests,
            workspaceCommitIds,
          );
          if (!reference) {
            throw new Error(
              `Issue #${issue.number} has no pull request after Pi finished\n\nPi output:\n${piOutput.trim() || "(none)"}`,
            );
          }
          const pullRequest = JSON.parse(
            await $`gh pr view ${reference.number} -R ${repo} --json number,state,url,body`.text(),
          ) as { body: string; number: number; state: string; url: string };
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
          if (pullRequest.state === "MERGED") {
            await deleteMergedBranch(workspacePath, repo, pullRequest.number);
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
