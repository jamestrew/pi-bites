#!/usr/bin/env bun
import { $ } from "bun";
import { existsSync } from "node:fs";
import {
  commandExists,
  defaults,
  prepareExtensionRuntime,
  processIssue,
  reconcileStaleWorkspaces,
} from "./run-ready-for-agent-issues.js";

function usage() {
  console.log(`Usage: ${process.argv[1]} [options] ISSUE_NUMBER...

Run the implementation/review/fix/PR pipeline for explicit GitHub issues.

Options:
  -j, --jobs N               Number of issues to run in parallel (default: ${defaults.jobs})
  -R, --repo REPO            GitHub repo (default: ${defaults.repo})
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
  const numbers = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (!next) throw new Error(`missing value for ${arg}`);
      return next;
    };
    switch (arg) {
      case "-j":
      case "--jobs":
        opts.jobs = Number(value());
        break;
      case "-R":
      case "--repo":
        opts.repo = value();
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
        if (arg.startsWith("-")) throw new Error(`Unknown argument: ${arg}`);
        if (!/^\d+$/.test(arg)) throw new Error(`Invalid issue number: ${arg}`);
        numbers.push(Number(arg));
    }
  }
  if (!Number.isInteger(opts.jobs) || opts.jobs < 1)
    throw new Error("--jobs must be a positive integer");
  if (numbers.length === 0) throw new Error("pass at least one issue number");
  return { opts, numbers: [...new Set(numbers)] };
}

async function main() {
  const { opts, numbers } = parseArgs(process.argv.slice(2));
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
  await reconcileStaleWorkspaces();
  const piArgs = await prepareExtensionRuntime(opts);

  const issues = await Promise.all(
    numbers.map(async (number) => {
      const json =
        await $`gh issue view ${number} -R ${opts.repo} --json number,title,body,url,labels,author,comments`.text();
      return JSON.parse(json);
    }),
  );

  let failures = 0;
  let index = 0;
  async function worker() {
    while (index < issues.length) {
      const issue = issues[index++];
      try {
        await processIssue(issue, opts, piArgs);
      } catch (error) {
        failures += 1;
        console.error(`Issue #${issue.number} failed:`);
        console.error(error);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(opts.jobs, issues.length) }, () => worker()));
  if (originalRev) await $`jj edit ${originalRev}`.quiet().nothrow();
  console.log(`Processed ${issues.length} issue(s) with ${failures} failure(s).`);
  if (failures > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
