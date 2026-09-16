import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkTag, release, releaseVersion } from "./release.ts";

describe("release versions", () => {
  it.each([
    ["--major", "2.0.0"],
    ["--minor", "1.3.0"],
    ["--patch", "1.2.4"],
    ["v1.2.3", "1.2.3"],
  ])("accepts %s", (arg, expected) => {
    expect(releaseVersion("1.2.3", [arg])).toBe(expected);
  });
  it.each([[], ["--patch", "--minor"], ["1.2.3"], ["v01.2.3"], ["v1.2.3-beta"], ["--wat"]])(
    "rejects invalid arguments %j",
    (...args) => {
      expect(() => releaseVersion("1.2.3", args)).toThrow();
    },
  );
  it("rejects mismatches", () => {
    expect(() => releaseVersion("1.2.3", ["v2.0.0"])).toThrow("mismatch");
  });
  it("checks peeled annotated tags and refuses to move tags", () => {
    expect(checkTag("", "v1.0.0", "commit")).toBe(false);
    expect(
      checkTag("object refs/tags/v1.0.0\ncommit refs/tags/v1.0.0^{}", "v1.0.0", "commit"),
    ).toBe(true);
    expect(() => checkTag("other refs/tags/v1.0.0", "v1.0.0", "commit")).toThrow("another commit");
  });
});

const directories: string[] = [];
beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-bites-release-"));
  directories.push(root);
  const cwd = join(root, "work");
  mkdirSync(cwd);
  const env = {
    ...process.env,
    JJ_CONFIG: "",
    JJ_USER: "Release Test",
    JJ_EMAIL: "release@example.test",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const real = (cmd: string, args: string[]) =>
    execFileSync(cmd, args, { cwd, env, encoding: "utf8", stdio: "pipe" }).trim();
  real("git", ["init", "--bare", "--initial-branch=master", join(root, "remote")]);
  real("jj", ["git", "init", "--colocate"]);
  writeFileSync(join(cwd, "package.json"), '{"version":"1.0.0"}\n');
  real("jj", ["commit", "-m", "Initial"]);
  const commit = real("jj", ["log", "-r", "@-", "--no-graph", "-T", "commit_id"]);
  real("git", ["remote", "add", "origin", join(root, "remote")]);
  real("git", ["push", "origin", `${commit}:refs/heads/master`]);
  const calls: string[][] = [];
  let failPublish = false;
  let modifyOnCheck = false;
  const run = (cmd: string, args: string[]) => {
    calls.push([cmd, ...args]);
    if (cmd === "gh") {
      if (args[0] === "release" && failPublish) throw new Error("Publish failed");
      return "";
    }
    if (cmd === "bun") {
      if (modifyOnCheck) writeFileSync(join(cwd, "changed.txt"), "formatter changed this");
      return "";
    }
    if (cmd === "git" && args[0] === "remote" && args[1] === "get-url")
      return "git@github.com:jamestrew/pi-bites.git";
    return real(cmd, args);
  };
  return {
    cwd,
    real,
    calls,
    run,
    fail: () => {
      failPublish = true;
    },
    fix: () => {
      failPublish = false;
    },
    modify: () => {
      modifyOnCheck = true;
    },
  };
}

it("bumps, commits, pushes and publishes, then safely retries a failed publication", async () => {
  const f = fixture();
  f.fail();
  await expect(release(["--minor"], f.run, async () => true)).rejects.toThrow("Publish failed");
  expect(JSON.parse(readFileSync(join(f.cwd, "package.json"), "utf8")).version).toBe("1.1.0");
  const tagCommit = f.real("git", ["rev-parse", "v1.1.0"]);
  expect(f.real("git", ["show", "v1.1.0:package.json"])).toContain('"1.1.0"');
  expect(f.real("git", ["ls-remote", "origin", "refs/heads/master"])).toContain(tagCommit);
  f.fix();
  await release(["v1.1.0"], f.run, async () => true);
  expect(f.real("git", ["rev-parse", "v1.1.0"])).toBe(tagCommit);
  expect(f.calls.filter((c) => c[0] === "jj" && c[1] === "commit")).toHaveLength(1);
  expect(f.calls.at(-1)).toEqual([
    "gh",
    "release",
    "create",
    "v1.1.0",
    "--repo",
    "jamestrew/pi-bites",
    "--verify-tag",
    "--generate-notes",
    "--title",
    "v1.1.0",
  ]);
});

it("does not mutate or publish when confirmation is declined", async () => {
  const f = fixture();
  await release(["--patch"], f.run, async () => false);
  expect(JSON.parse(readFileSync(join(f.cwd, "package.json"), "utf8")).version).toBe("1.0.0");
  expect(f.calls.some((c) => c.includes("push") || c.includes("create"))).toBe(false);
});

it("rejects mismatches and changes made by validation before publishing", async () => {
  const f = fixture();
  await expect(release(["v2.0.0"], f.run, async () => true)).rejects.toThrow("mismatch");
  f.modify();
  await expect(release(["v1.0.0"], f.run, async () => true)).rejects.toThrow(
    "empty, single-parent",
  );
  expect(f.calls.some((c) => c.includes("push") || c.includes("create"))).toBe(false);
});

it("refuses a conflicting remote tag without overwriting it", async () => {
  const f = fixture();
  f.real("git", ["tag", "v1.0.0"]);
  f.real("git", ["push", "origin", "refs/tags/v1.0.0"]);
  writeFileSync(join(f.cwd, "feature.txt"), "new feature");
  f.real("jj", ["commit", "-m", "Feature"]);
  const newer = f.real("jj", ["log", "-r", "@-", "--no-graph", "-T", "commit_id"]);
  f.real("git", ["push", "origin", `${newer}:refs/heads/master`]);
  await expect(release(["v1.0.0"], f.run, async () => true)).rejects.toThrow("another commit");
  expect(f.calls.some((c) => c.includes("push") || c.includes("create"))).toBe(false);
});

it("stops when checks fail", async () => {
  const f = fixture();
  await expect(
    release(
      ["--patch"],
      (cmd, args) => {
        if (cmd === "bun") throw new Error("Checks failed");
        return f.run(cmd, args);
      },
      async () => true,
    ),
  ).rejects.toThrow("Checks failed");
  expect(JSON.parse(readFileSync(join(f.cwd, "package.json"), "utf8")).version).toBe("1.0.0");
  expect(f.calls.some((c) => c.includes("push") || c.includes("create"))).toBe(false);
});
