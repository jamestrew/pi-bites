#!/usr/bin/env bun
import { $ } from "bun";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

const defaults = {
  repo: "jamestrew/pi-bites",
  limit: 0,
  jobs: 1,
  loops: 2,
  label: "ready-for-agent",
  baseBranch: "master",
  reviewSkill: "/home/jt/.agents/skills/thermonuclear-review/SKILL.md",
  handoffSkill: "/home/jt/.agents/skills/handoff/SKILL.md",
  piArgs: ["--print", "--approve", "--yolo"],
  extensionRuntime: join(homedir(), ".cache/pi-bites-agent-extension"),
  extensionWorkspaceName: "pi-bites-agent-extension-runtime",
  extensionRef: "master@origin",
  extensionSnapshot: true,
};

function usage() {
  console.log(`Usage: ${process.argv[1]} [--limit N] [--jobs N] [--repo OWNER/REPO] [--label LABEL] [--base BRANCH] [--review-skill PATH] [--handoff-skill PATH] [--pi-arg ARG ...]

Find open ready-for-agent issues for this repo that are not blocked by any open
native GitHub blocking relationship and do not already have an open linked PR,
then run a non-interactive pi implementation/review/fix/PR pipeline for each issue.

Options:
  -n, --limit N              Maximum number of issues to work on per loop (default: no cap)
  -j, --jobs N               Number of issues to run in parallel (default: ${defaults.jobs})
  --loops N                  Number of discovery/work loops to run, allowing newly unblocked issues to be picked up (default: ${defaults.loops}; 0 = until no candidates)
  -R, --repo REPO            GitHub repo (default: ${defaults.repo})
  -l, --label LABEL          Ready label (default: ${defaults.label}; also falls back to read-for-agent)
  -b, --base BRANCH          Base branch for work branches/PRs (default: ${defaults.baseBranch})
  --review-skill PATH        Thermo-nuclear review skill path
  --handoff-skill PATH       Handoff skill path
  --pi-arg ARG               Extra argument passed to every pi invocation (repeatable)
  --extension-runtime PATH   Stable pi-bites extension snapshot dir (default: ${defaults.extensionRuntime})
  --extension-ref REV        jj rev to archive for pi extension runtime (default: ${defaults.extensionRef})
  --no-extension-snapshot    Use pi's normal extension loading instead of a stable snapshot
  -h, --help                 Show this help

Requires: gh, jj, pi, bun`);
}

function parseArgs(argv) {
  const opts = structuredClone(defaults);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (!next) throw new Error(`missing value for ${arg}`);
      return next;
    };
    switch (arg) {
      case "-n":
      case "--limit":
        opts.limit = Number(value());
        break;
      case "-j":
      case "--jobs":
        opts.jobs = Number(value());
        break;
      case "--loops":
        opts.loops = Number(value());
        break;
      case "-R":
      case "--repo":
        opts.repo = value();
        break;
      case "-l":
      case "--label":
        opts.label = value();
        break;
      case "-b":
      case "--base":
        opts.baseBranch = value();
        break;
      case "--review-skill":
        opts.reviewSkill = value();
        break;
      case "--handoff-skill":
        opts.handoffSkill = value();
        break;
      case "--pi-arg":
        opts.piArgs.push(value());
        break;
      case "--extension-runtime":
        opts.extensionRuntime = value();
        break;
      case "--extension-ref":
        opts.extensionRef = value();
        break;
      case "--no-extension-snapshot":
        opts.extensionSnapshot = false;
        break;
      case "-h":
      case "--help":
        usage();
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!Number.isInteger(opts.limit) || opts.limit < 0)
    throw new Error("--limit must be a non-negative integer");
  if (!Number.isInteger(opts.jobs) || opts.jobs < 1)
    throw new Error("--jobs must be a positive integer");
  if (!Number.isInteger(opts.loops) || opts.loops < 0)
    throw new Error("--loops must be a non-negative integer");
  return opts;
}

async function commandExists(cmd) {
  try {
    await $`which ${cmd}`.quiet();
    return true;
  } catch {
    return false;
  }
}

function slugify(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function nodes(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object" && Array.isArray(value.nodes)) return value.nodes;
  return [];
}

function issueIsUnblocked(issue) {
  return nodes(issue.blockedBy).filter((blocker) => blocker.state !== "CLOSED").length === 0;
}

function issueHasOpenPr(issue) {
  return nodes(issue.closedByPullRequestsReferences).filter((pr) => pr.state === "OPEN").length > 0;
}

async function fetchCandidates(opts, label) {
  try {
    const out =
      await $`gh issue list -R ${opts.repo} --state open --label ${label} --limit 1000 --json number`.text();
    return JSON.parse(out).map((issue) => issue.number);
  } catch {
    return [];
  }
}

async function prepareExtensionRuntime(opts) {
  if (!opts.extensionSnapshot) return opts.piArgs;

  const runtime = opts.extensionRuntime;
  console.log(`Preparing stable pi extension runtime: ${runtime} (${opts.extensionRef})`);
  await $`jj workspace forget ${opts.extensionWorkspaceName}`.quiet().nothrow();
  await rm(runtime, { recursive: true, force: true });
  await $`jj workspace add --name ${opts.extensionWorkspaceName} --revision ${opts.extensionRef} ${runtime}`;
  await $`bun install --frozen-lockfile`.cwd(runtime);
  await $`bun check`.cwd(runtime);
  await $`pi -n -e ${join(runtime, "packages/ext/index.ts")} --print Say OK`.quiet();

  return ["-n", "-e", join(runtime, "packages/ext/index.ts"), ...opts.piArgs];
}

async function ensureJjDescription(cwd, number, title) {
  const description = (
    await $`jj log -r @ --no-graph --template description`
      .cwd(cwd)
      .quiet()
      .text()
      .catch(() => "")
  ).trimEnd();
  if (!description) await $`jj describe -m ${`feat: ${title} (#${number})`}`.cwd(cwd);
}

async function writeTemp(prefix, content = "") {
  const dir = await mkdtemp(join(tmpdir(), `${prefix}-`));
  const path = join(dir, "payload");
  await writeFile(path, content);
  return { dir, path };
}

async function runPi(cwd, piArgs, name, prompt, skills = []) {
  const skillArgs = skills.flatMap((skill) => ["--skill", skill]);
  await $`pi ${piArgs} --name ${name} ${skillArgs} ${prompt}`.cwd(cwd);
}

function buildIssuePrompt(issue, opts) {
  const number = issue.number;
  return [
    `You are working in the GitHub repository ${opts.repo}.`,
    `Implement issue #${number}: ${issue.title}`,
    "",
    `Issue URL: ${issue.url}`,
    "",
    `Labels: ${issue.labels.map((label) => label.name).join(", ")}`,
    "",
    `Issue body:\n${issue.body ?? ""}`,
    "",
    `Comments:\n${(issue.comments ?? []).map((comment) => `---\n@${comment.author.login}:\n${comment.body}`).join("\n")}`,
    "",
    "Instructions:",
    "- Treat this as an AFK ready-for-agent issue.",
    "- Make the smallest complete change that satisfies the acceptance criteria.",
    "- Use jj, not git, for VCS operations. Do not run git diff/status/commit.",
    `- This may be a jj workspace without .git metadata; gh cannot infer the repo. Pass \`-R ${opts.repo}\` to every gh command.`,
    `- For diffs, compare against ${opts.baseBranch}@origin with jj, for example \`jj diff --from ${opts.baseBranch}@origin\`.`,
    "- Run relevant checks, including `bun check` before finishing.",
    `- Describe the current jj change with a clear git conventional message mentioning #${number}.`,
    "- Do not create a PR yet; a separate review/fix/PR pipeline will run next.",
    "- If you cannot safely complete the issue, leave the worktree clean and explain why.",
  ].join("\n");
}

async function runImplementPi(cwd, piArgs, issuePrompt, issue) {
  await runPi(cwd, piArgs, `issue #${issue.number} implement`, issuePrompt);
}

async function runReviewPi(cwd, piArgs, issue, opts, promptFile, reviewHandoff) {
  await runPi(
    cwd,
    piArgs,
    `issue #${issue.number} review`,
    `Review the current jj change for issue #${issue.number} using the thermo-nuclear-code-quality-review skill.

Original issue prompt is in: ${promptFile.path}
Base branch/change is: ${opts.baseBranch}@origin

Use jj commands only. Do not run git diff/status/commit. For the changed-code diff, use 'jj diff --from ${opts.baseBranch}@origin' or equivalent jj commands; do not assume the base branch is main.

This may be a jj workspace without .git metadata; gh cannot infer the repo. Pass '-R ${opts.repo}' to every gh command.

Write the review results as a handoff document to exactly this path:
${reviewHandoff.path}

The handoff must summarize high-conviction review findings, obvious/critical fixes to make, and suggested skills for the next agent. Do not modify code in this review session.`,
    [opts.reviewSkill, opts.handoffSkill],
  );
}

async function runFixReviewPi(cwd, piArgs, issue, opts, promptFile, reviewHandoff) {
  await runPi(
    cwd,
    piArgs,
    `issue #${issue.number} fix review`,
    `Implement the obvious or critical fixes/refactors from this review handoff:
${reviewHandoff.path}

Original issue prompt is in: ${promptFile.path}

Instructions:
- Use jj, not git, for VCS operations. Do not run git diff/status/commit. Squash any code changes into the original change.
- This may be a jj workspace without .git metadata; gh cannot infer the repo. Pass '-R ${opts.repo}' to every gh command.
- For diffs, compare against ${opts.baseBranch}@origin with jj, for example 'jj diff --from ${opts.baseBranch}@origin'; do not assume the base branch is main.
- Preserve the behavior required by issue #${issue.number}.
- Run relevant checks, including bun check when appropriate.
- Update the review handoff in place, noting what was addressed and what was intentionally left unaddressed.
- Do not create a PR; a separate session will do that next.`,
    [opts.handoffSkill],
  );
}

async function runCreatePrPi(cwd, piArgs, issue, opts, promptFile, reviewHandoff, branch) {
  await runPi(
    cwd,
    piArgs,
    `issue #${issue.number} create PR`,
    `Create the pull request for issue #${issue.number}.

Original issue prompt is in: ${promptFile.path}
Review/fix handoff is in: ${reviewHandoff.path}
Branch/bookmark name to use: ${branch}
Base branch: ${opts.baseBranch}
Repo: ${opts.repo}

Instructions:
- Read the original issue prompt and review handoff.
- Use jj, not git, for VCS operations. Do not run git diff/status/commit.
- This may be a jj workspace without .git metadata; gh cannot infer the repo. Pass '-R ${opts.repo}' to every gh command.
- For diffs, compare against ${opts.baseBranch}@origin with jj, for example 'jj diff --from ${opts.baseBranch}@origin'; do not assume the base branch is main.
- Ensure the current jj change has a good description mentioning #${issue.number}.
- Create or update a jj bookmark named ${branch} pointing at the current change.
- Push it with jj to GitHub.
- Create the PR non-interactively with 'gh pr create -R ${opts.repo} -B ${opts.baseBranch} -H ${branch} --title ... --body ...' or '--body-file ...'.
- Do not rely on gh prompts or repo inference.
- The PR body must include Closes #${issue.number}.
- The PR description should summarize the implementation, explain non-obvious code areas and critical code paths, and explicitly cover review comments that were not addressed by the fix agent.
- The PR description must highlight the changeset seams: the critical interfaces/places where behavior changed or can be altered, and what the maintainer should understand or pay attention to when reviewing them.
- Keep the PR description extremely concise. Sacrifice grammar for the sake of concision.
- After creating the PR, inspect the review/fix handoff. If it shows 0 remaining review issues / no intentionally unaddressed review findings, fetch origin, rebase the current jj change onto latest ${opts.baseBranch}@origin, update the ${branch} bookmark, push it, then merge the PR non-interactively with gh using rebase semantics. If any review issue remains, leave the PR open for human review.`,
  );
}

async function processIssue(issue, opts, piArgs) {
  const number = issue.number;
  const title = issue.title;
  const branch = `agent/issue-${number}-${slugify(title)}`;
  console.log(`Working #${number}: ${title}`);

  let cwd = process.cwd();
  let workspaceName = "";
  let workspaceDir = "";
  if (opts.jobs > 1) {
    workspaceDir = await mkdtemp(join(tmpdir(), `pi-bites-issue-${number}-workspace-`));
    workspaceName = `issue-${number}-${process.pid}`;
    await $`jj workspace add --name ${workspaceName} --revision ${`${opts.baseBranch}@origin`} ${workspaceDir}`;
    cwd = workspaceDir;
  } else {
    await $`jj new ${`${opts.baseBranch}@origin`}`;
  }

  const issuePrompt = buildIssuePrompt(issue, opts);
  const promptFile = await writeTemp(`pi-bites-issue-${number}-prompt`, issuePrompt);
  const reviewHandoff = await writeTemp(`pi-bites-issue-${number}-review`, "");

  try {
    await runImplementPi(cwd, piArgs, issuePrompt, issue);
    await ensureJjDescription(cwd, number, title);

    await runReviewPi(cwd, piArgs, issue, opts, promptFile, reviewHandoff);

    await runFixReviewPi(cwd, piArgs, issue, opts, promptFile, reviewHandoff);
    await ensureJjDescription(cwd, number, title);

    await runCreatePrPi(cwd, piArgs, issue, opts, promptFile, reviewHandoff, branch);
  } finally {
    await rm(promptFile.dir, { recursive: true, force: true });
    if (workspaceDir) {
      await $`jj workspace forget ${workspaceName}`.quiet().nothrow();
      await rm(workspaceDir, { recursive: true, force: true });
    }
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  for (const cmd of ["gh", "jj", "pi", "bun"]) {
    if (!(await commandExists(cmd))) throw new Error(`Missing required command: ${cmd}`);
  }
  for (const skill of [opts.reviewSkill, opts.handoffSkill]) {
    if (!existsSync(skill)) throw new Error(`Missing skill file: ${skill}`);
  }

  const originalRev = (
    await $`jj log -r @ --no-graph --template change_id`
      .quiet()
      .text()
      .catch(() => "")
  ).trim();
  await $`jj git fetch --remote origin`;
  const piArgs = await prepareExtensionRuntime(opts);

  let totalSelected = 0;
  let totalFailures = 0;
  let loop = 0;
  while (opts.loops === 0 || loop < opts.loops) {
    loop += 1;
    console.log(
      `Starting issue discovery loop ${loop}${opts.loops === 0 ? "" : `/${opts.loops}`}.`,
    );

    await $`jj git fetch --remote origin`;
    const numbers = [
      ...new Set([
        ...(await fetchCandidates(opts, opts.label)),
        ...(await fetchCandidates(opts, "read-for-agent")),
      ]),
    ].sort((a, b) => a - b);
    const selected = [];
    for (const number of numbers) {
      const json =
        await $`gh issue view ${number} -R ${opts.repo} --json number,title,body,url,labels,author,comments,blockedBy,closedByPullRequestsReferences`.text();
      const issue = JSON.parse(json);
      if (!issueIsUnblocked(issue)) {
        const blockers = nodes(issue.blockedBy)
          .filter((blocker) => blocker.state !== "CLOSED")
          .map((blocker) => `#${blocker.number}`)
          .join(", ");
        console.log(`Skipping #${number}: blocked by ${blockers || "unknown open blocker"}`);
        continue;
      }
      if (issueHasOpenPr(issue)) {
        const prs = nodes(issue.closedByPullRequestsReferences)
          .filter((pr) => pr.state === "OPEN")
          .map((pr) => `#${pr.number}`)
          .join(", ");
        console.log(`Skipping #${number}: already has open PR ${prs || "unknown"}`);
        continue;
      }
      selected.push(issue);
      if (opts.limit > 0 && selected.length >= opts.limit) break;
    }

    if (selected.length === 0) {
      console.log(`No candidate issues found in loop ${loop}.`);
      break;
    }

    let failures = 0;
    let index = 0;
    async function worker() {
      while (index < selected.length) {
        const issue = selected[index++];
        try {
          await processIssue(issue, opts, piArgs);
        } catch (error) {
          failures += 1;
          console.error(`Issue #${issue.number} failed:`);
          console.error(error);
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(opts.jobs, selected.length) }, () => worker()));
    totalSelected += selected.length;
    totalFailures += failures;
    console.log(`Loop ${loop} processed ${selected.length} issue(s) with ${failures} failure(s).`);

    if (failures > 0) break;
  }

  if (originalRev) await $`jj edit ${originalRev}`.quiet().nothrow();

  console.log(`Processed ${totalSelected} issue(s) with ${totalFailures} failure(s).`);
  if (totalFailures > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
