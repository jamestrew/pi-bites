import { describe, expect, test } from "vitest";
import { findMatchedPattern, findMatchedPatterns } from "./index.js";

describe("findMatchedPattern", () => {
  test.each([
    "cat README.md 2>&1",
    "cat README.md 1>&2",
    "cat README.md 2>/dev/null",
    "cat README.md >/dev/null",
    "cat README.md >>/dev/null",
    "printf build 2>/dev/null | wc -c",
    "printf '%s\n' code-refactor",
    "grep -R needle packages",
    "rg needle .",
    "find packages -name '*.ts' -print",
    "cal",
    "cksum README.md",
    "free -h",
    "md5sum README.md",
    "ps aux",
    "sha256sum README.md",
    "uptime",
    "tree packages",
    "aws sts get-caller-identity",
    "cargo test",
    "docker ps",
    "dotnet test",
    "ecs check",
    "glab mr view 42",
    "go test ./...",
    "golangci-lint run",
    "gradlew test",
    "gt log",
    "jest --runInBand",
    "kubectl get pods",
    "mvn test",
    "mypy packages",
    "next build",
    "npm test",
    "oc get pods",
    "paratest",
    "pest",
    "php -l index.php",
    "phpstan analyse",
    "phpunit",
    "pint --test",
    "pip list",
    "playwright test",
    "pnpm test",
    "prettier --check .",
    "prisma validate",
    "pytest -q",
    "rake test",
    "rspec",
    "rubocop",
    "ruff check .",
    "sbt test",
    "tsc --noEmit",
    "uv tree",
    "vitest run",
    "gh auth status",
    "gh issue list --repo owner/repo",
    "gh issue view 42",
    "gh pr checks 42",
    "gh pr diff 42",
    "gh pr view 42 --json title,state",
    "gh run list --limit 10",
    "gh workflow view ci.yml",
    "git add packages/ext/bash-gate/index.ts",
    "git blame packages/ext/bash-gate/index.ts",
    "git commit -m 'relax bash gate'",
    "git diff --stat",
    "git log -5 --oneline",
    "git ls-files '*.ts'",
    "git name-rev HEAD",
    "git pull --rebase",
    "git rebase main",
    "git rev-list --count HEAD",
    "git rev-parse --show-toplevel",
    "git shortlog -sn",
    "git show --stat HEAD",
    "git status --short --branch",
    "jj status",
    "jj st",
    "jj log -r @",
    "jj diff --summary",
    "jj bookmark list",
    "jj b list",
    "jj operation show",
    "jj op log",
    "jj file show README.md",
    "jj file track new-file.ts",
    "jj file untrack generated.txt",
    "jj git fetch",
    "jj new main",
    "jj commit -m 'relax bash gate'",
    "jj describe -m 'relax bash gate'",
    "jj edit @-",
    "jj rebase -d main",
    "jj restore README.md",
    "jj split packages/ext/bash-gate/index.ts",
    "jj squash",
    "jj abandon @",
    "jj workspace list",
    "sed -n '1,130p' packages/ext/codex-adapter/apply-patch/rendering.ts && sed -n '220,280p' packages/ext/codex-adapter/apply-patch.test.ts",
  ])("allows allowlisted command: %s", async (command: string) => {
    expect(await findMatchedPattern(command)).toBeUndefined();
  });

  test.each([
    ["echo hi > out.txt", "redirect:>"],
    ["cat < in.txt > out.txt", "redirect:>"],
    ["make build >/tmp/build.log 2>&1", "redirect:>"],
    ["echo hi >> out.txt", "redirect:>>"],
    ["rm -rf tmp", "rm"],
    ["find . -delete", "find -delete"],
    ["find . -exec rm {} +", "find -exec"],
    ["find . -fprint matches.txt", "find -fprint"],
    ["rg --pre cat needle .", "rg --pre"],
    ["rg --pre=cat needle .", "rg --pre"],
    ["rg --hostname-bin=./script needle .", "rg --hostname-bin"],
    ["printf -v PATH .", "printf -v"],
    ["printf -vPATH .", "printf -v"],
    ["printf -v PATH .; cat README.md", "printf -v"],
    ["sort -o result.txt README.md", "sort -o"],
    ["sort --output=result.txt README.md", "sort --output"],
    ["sort --compress-program=./evil README.md", "sort --compress-program"],
    ["file -C -m magic", "file -c"],
    ["date --set=tomorrow", "date --set"],
    ["git show --output=commit.txt HEAD", "git --output"],
    ["git show --ext-diff HEAD", "git --ext-diff"],
    ["git show --textconv HEAD", "git --textconv"],
    ["git grep --open-files-in-pager=cat needle", "git --open-files-in-pager"],
    ["git grep -Ocat needle", "git grep"],
    ["go env -w GOTOOLCHAIN=local", "go env"],
    ["mypy --install-types", "mypy --install-types"],
    ["pytest --basetemp=/tmp/pytest", "pytest --basetemp"],
    ["tree -o listing.txt", "tree -o"],
    ["ssh prod 'rm -rf /data'", "ssh"],
    ["scp artifact.tar prod:/srv", "scp"],
    ["sftp prod", "sftp"],
    ["git push origin main", "git push"],
    ["git branch -D old-branch", "git branch -d"],
    ["git rebase --exec 'rm -rf tmp' main", "git rebase"],
    ["git rebase -x'rm -rf tmp' main", "git rebase"],
    ["bun add zod", "bun add"],
    ["service nginx restart", "service restart"],
  ])("matches a destructive pattern for: %s", async (command: string, label: string) => {
    const matched = await findMatchedPattern(command);

    expect(matched).toBeDefined();
    expect(matched?.label).toBe(label);
  });

  test.each([
    ["aws s3 rm s3://bucket/key", "unlisted: aws s3 rm s3://bucket/key"],
    ["cargo publish", "unlisted: cargo publish"],
    ["docker rm app", "unlisted: docker rm app"],
    ["glab mr merge 42", "unlisted: glab mr merge 42"],
    ["go install example.com/tool@latest", "unlisted: go install example.com/tool@latest"],
    ["kubectl delete pod app", "unlisted: kubectl delete pod app"],
    ["npm run deploy", "unlisted: npm run deploy"],
    ["playwright install", "unlisted: playwright install"],
    ["prisma migrate deploy", "unlisted: prisma migrate deploy"],
    ["date -u", "unlisted: date -u"],
    ["date 082122002026", "unlisted: date 082122002026"],
    ["git grep bashGate", "unlisted: git grep bashGate"],
    ["git grep --open=cat needle", "unlisted: git grep --open=cat needle"],
    [
      "python3 -c 'import shutil; shutil.rmtree(\"tmp\")'",
      "unlisted: python3 -c 'import shutil; shutil.rmtree(\"tmp\")'",
    ],
    ["./cat README.md", "unlisted: ./cat README.md"],
    ["PATH=. cat README.md", "unlisted: PATH=. cat README.md"],
    ["CAT README.md", "unlisted: CAT README.md"],
    ["gh issue close 42", "unlisted: gh issue close 42"],
    ["gh pr merge 42", "unlisted: gh pr merge 42"],
    [
      "gh api --method DELETE repos/o/r/issues/1",
      "unlisted: gh api --method DELETE repos/o/r/issues/1",
    ],
    ["jj bookmark delete old", "unlisted: jj bookmark delete old"],
    ["jj operation restore abc", "unlisted: jj operation restore abc"],
    ["jj file chmod +x script", "unlisted: jj file chmod +x script"],
    ["sed -ni '1,20p' file", "unlisted: sed -ni '1,20p' file"],
    ["sed -n '1e touch /tmp/pwned' file", "unlisted: sed -n '1e touch /tmp/pwned' file"],
    ["sed -n '1,20p;w out' file", "unlisted: sed -n '1,20p;w out' file"],
    ["sed -n '1,20p' -i file", "unlisted: sed -n '1,20p' -i file"],
  ])("gates commands outside the allowlist: %s", async (command: string, label: string) => {
    const matched = await findMatchedPattern(command);

    expect(matched?.label).toBe(label);
    expect(matched?.source).toBe("builtin");
    expect(matched?.reason).toContain("not on the bash-gate allowlist");
  });

  test("matches every gated command in a compound command", async () => {
    const matches = await findMatchedPatterns("chmod +x foo && rm bar");

    expect(matches.map((match) => match.label)).toEqual(expect.arrayContaining(["chmod", "rm"]));
  });

  test("matches every gated command separated by semicolons", async () => {
    const matches = await findMatchedPatterns("rmdir a; rm b");

    expect(matches.map((match) => match.label)).toEqual(["rmdir", "rm"]);
  });

  test("supports configured command-only rules", async () => {
    const matched = await findMatchedPattern("pytest -q", {
      bashGate: { rules: [{ cmd: "pytest" }] },
    });

    expect(matched?.label).toBe("pytest");
    expect(matched?.source).toBe("configured");
  });

  test("supports configured subcommand rules", async () => {
    const matched = await findMatchedPattern("git push origin main", {
      bashGate: {
        rules: [{ cmd: "git", subcommands: ["push"], reason: "push mutates remote state" }],
      },
    });

    expect(matched?.label).toBe("git push");
    expect(matched?.reason).toBe("push mutates remote state");
  });

  test("supports configured flagAny rules", async () => {
    const matched = await findMatchedPattern("sed -i 's/a/b/' file.txt", {
      bashGate: { rules: [{ cmd: "sed", flagAny: ["-i"] }] },
    });

    expect(matched?.label).toBe("sed -i");
    expect(matched?.source).toBe("configured");
  });

  test("supports configured redirect rules", async () => {
    const matched = await findMatchedPattern("echo hi >> out.txt", {
      bashGate: { rules: [{ redirects: "append" }] },
    });

    expect(matched?.label).toBe("redirect:>>");
    expect(matched?.source).toBe("configured");
  });

  test("configured rules extend builtin defaults", async () => {
    const builtinMatch = await findMatchedPattern("git push origin main", {
      bashGate: { rules: [{ cmd: "sed", flagAny: ["-i"] }] },
    });
    const configuredMatch = await findMatchedPattern("sed -i 's/a/b/' file.txt", {
      bashGate: { rules: [{ cmd: "sed", flagAny: ["-i"] }] },
    });

    expect(builtinMatch?.label).toBe("git push");
    expect(builtinMatch?.source).toBe("builtin");
    expect(configuredMatch?.label).toBe("sed -i");
    expect(configuredMatch?.source).toBe("configured");
  });
});
