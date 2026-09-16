import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

const usage = "bun run release <vMAJOR.MINOR.PATCH | --major | --minor | --patch>";
const repository = "jamestrew/pi-bites";

export function releaseVersion(current: string, args: string[]): string {
  const pattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
  if (!pattern.test(current)) throw new Error(`Invalid package version: ${current}`);
  const [arg] = args;
  if (args.length !== 1 || !arg) throw new Error(usage);
  const index = ["--major", "--minor", "--patch"].indexOf(arg);
  if (index >= 0) {
    const parts = current.split(".").map(BigInt);
    return parts.map((part, i) => (i < index ? part : i === index ? part + 1n : 0n)).join(".");
  }
  if (!arg.startsWith("v") || !pattern.test(arg.slice(1))) throw new Error(usage);
  if (arg !== `v${current}`) throw new Error(`Tag/version mismatch: ${arg} != v${current}`);
  return current;
}

type Run = (command: string, args: string[], live?: boolean) => string;
const run: Run = (command, args, live = false) =>
  execFileSync(command, args, { encoding: "utf8", stdio: live ? "inherit" : "pipe" })?.trim() ?? "";

// Existing tags are reusable only for the exact same commit; never force or delete them.
export function checkTag(output: string, tag: string, commit: string): boolean {
  const refs = new Map(
    output
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [hash, ref] = line.split(/\s+/);
        return [ref, hash];
      }),
  );
  const existing = refs.get(`refs/tags/${tag}^{}`) ?? refs.get(`refs/tags/${tag}`);
  if (existing && existing !== commit) throw new Error(`${tag} already points to another commit`);
  return existing !== undefined;
}

export async function release(
  args: string[],
  command: Run = run,
  confirm: (message: string) => Promise<boolean> = async (message) => {
    if (!process.stdin.isTTY) throw new Error("Release requires an interactive terminal");
    const input = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return (await input.question(`${message}\nPublish? [y/N] `)).toLowerCase() === "y";
    } finally {
      input.close();
    }
  },
): Promise<void> {
  const jj = (...args: string[]) => command("jj", args);
  const git = (...args: string[]) => command("git", args);
  const clean = () => {
    if (jj("log", "-r", "@", "--no-graph", "-T", 'empty ++ " " ++ parents.len()') !== "true 1") {
      throw new Error(
        "Start with an empty, single-parent jj working copy (commit changes, then jj new if needed)",
      );
    }
  };
  clean();
  let commit = jj("log", "-r", "@-", "--no-graph", "-T", "commit_id");
  const manifest = JSON.parse(git("show", `${commit}:package.json`)) as { version: string };
  const version = releaseVersion(manifest.version, args);
  const bump = version !== manifest.version;
  const tag = `v${version}`;
  const remote = git("remote", "get-url", "origin");
  if (
    !/^(?:git@github\.com:|https:\/\/github\.com\/|ssh:\/\/git@github\.com\/)jamestrew\/pi-bites(?:\.git)?$/.test(
      remote,
    ) ||
    git("remote", "get-url", "--push", "origin") !== remote
  ) {
    throw new Error(`origin must fetch and push ${repository}`);
  }
  command("gh", ["auth", "status"], true);
  const head = git("ls-remote", "--symref", "origin", "HEAD");
  const branch = head.match(/^ref: (refs\/heads\/\S+)\s+HEAD$/m)?.[1];
  const tip = head.match(/^([a-f0-9]{40,64})\s+HEAD$/m)?.[1];
  if (!branch || !tip) throw new Error("Cannot determine origin's default branch");
  git("fetch", "--no-tags", "origin", branch);
  git("merge-base", "--is-ancestor", commit, "FETCH_HEAD");
  if (bump && commit !== tip)
    throw new Error("Increment releases must start at origin's default-branch tip");
  const remoteTags = () =>
    git("ls-remote", "--tags", "origin", `refs/tags/${tag}`, `refs/tags/${tag}^{}`);
  const localTags = () => git("show-ref", "--tags", "--dereference");
  // for-each-ref succeeds even when the repository has no tags.
  const localTagExists = () =>
    git("for-each-ref", "--format=%(refname)", `refs/tags/${tag}`) !== "";
  const existingRemote = remoteTags();
  if (bump && (existingRemote || localTagExists()))
    throw new Error(`${tag} already exists; retry with the explicit tag instead`);
  if (!bump) {
    checkTag(existingRemote, tag, commit);
    if (localTagExists()) checkTag(localTags(), tag, commit);
  }
  console.log(`Checking ${tag} from ${commit}`);
  command("bun", ["check"], true);
  clean();
  if (jj("log", "-r", "@-", "--no-graph", "-T", "commit_id") !== commit)
    throw new Error("Release commit changed during validation");
  if (
    !(await confirm(
      `${bump ? "Commit version bump, push to " + branch + ", and release" : "Release"} ${tag} from ${commit} on ${repository}`,
    ))
  )
    return;
  clean();
  if (jj("log", "-r", "@-", "--no-graph", "-T", "commit_id") !== commit)
    throw new Error("Release commit changed during confirmation");
  if (bump) {
    const path = join(jj("workspace", "root"), "package.json");
    const file = JSON.parse(readFileSync(path, "utf8"));
    file.version = version;
    writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
    jj(
      "commit",
      "-m",
      `chore(release): ${tag}\n\nPrepare the package version for the GitHub release.\n\nRef #287`,
    );
    commit = jj("log", "-r", "@-", "--no-graph", "-T", "commit_id");
    console.log(`If interrupted, push ${commit} to ${branch}, then retry: bun run release ${tag}`);
    git("push", "origin", `${commit}:${branch}`);
  }
  // Verify the committed artifact, not just the requested version, before tagging.
  releaseVersion(
    (JSON.parse(git("show", `${commit}:package.json`)) as { version: string }).version,
    [tag],
  );
  if (!checkTag(remoteTags(), tag, commit)) {
    if (localTagExists()) checkTag(localTags(), tag, commit);
    else git("-c", "tag.gpgSign=false", "tag", tag, commit);
    git("push", "origin", `refs/tags/${tag}:refs/tags/${tag}`);
  }
  console.log(`Tag published. Retry safely with: bun run release ${tag}`);
  command(
    "gh",
    [
      "release",
      "create",
      tag,
      "--repo",
      repository,
      "--verify-tag",
      "--generate-notes",
      "--title",
      tag,
    ],
    true,
  );
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") console.log(usage);
  else {
    try {
      process.chdir(fileURLToPath(new URL("..", import.meta.url)));
      await release(args);
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    }
  }
}
