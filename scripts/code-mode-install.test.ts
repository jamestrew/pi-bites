import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterEach, expect, test } from "vitest";

const root = resolve(import.meta.dirname, "..");
const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture(arch: "x86_64" | "aarch64") {
  const directory = mkdtempSync(join(tmpdir(), "code-mode-install-"));
  temporary.push(directory);
  const repository = join(directory, "checkout");
  const bin = join(directory, "bin");
  const scripts = join(repository, "scripts");
  mkdirSync(bin);
  mkdirSync(scripts, { recursive: true });
  cpSync(
    join(root, "packages/ext/codex-adapter/vendor/code-mode/licenses"),
    join(repository, "packages/ext/codex-adapter/vendor/code-mode/licenses"),
    { recursive: true },
  );
  for (const name of [
    "vendor/code-mode/LICENSE",
    "vendor/code-mode/NOTICE",
    "vendor/code-mode/THIRD_PARTY_LICENSES.html",
    "LICENSE",
  ]) {
    cpSync(
      join(root, "packages/ext/codex-adapter", name),
      join(repository, "packages/ext/codex-adapter", name),
    );
  }
  const asset = `codex-code-mode-host-${arch}-unknown-linux-musl`;
  const payload = "#!/bin/sh\nprintf 'fixture host\\n'\n";
  writeFileSync(join(directory, asset), payload);
  const archive = join(directory, "host.tar.gz");
  expect(spawnSync("tar", ["-czf", archive, "-C", directory, asset]).status).toBe(0);
  const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
  // Substitute fixture pins; the installer still uses real sha256sum and tar.
  const source = readFileSync(join(root, "scripts/code-mode-install.sh"), "utf8")
    .replace(
      /code_mode_archive_sha=[a-f0-9]+/g,
      `code_mode_archive_sha=${digest(readFileSync(archive))}`,
    )
    .replace(/code_mode_binary_sha=[a-f0-9]+/g, `code_mode_binary_sha=${digest(payload)}`);
  const script = join(scripts, "code-mode-install.sh");
  writeFileSync(script, source);
  writeFileSync(
    join(bin, "uname"),
    `#!/bin/sh\ncase "$1" in -s) echo Linux ;; -m) echo ${arch} ;; esac\n`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(bin, "curl"),
    `#!/bin/sh
while [ "$#" -gt 0 ]; do
  case "$1" in
    https://*) printf '%s\\n' "$1" > "$INSTALL_TEST_URL" ;;
    -o) shift; cp "$INSTALL_TEST_ARCHIVE" "$1" ;;
  esac
  shift
done
`,
    { mode: 0o755 },
  );
  const run = (args: string[], cdpath?: string) =>
    spawnSync("bash", [relative(directory, script), ...args], {
      cwd: directory,
      env: {
        ...process.env,
        CDPATH: cdpath ?? "",
        PATH: `${bin}:${process.env.PATH}`,
        INSTALL_TEST_ARCHIVE: archive,
        INSTALL_TEST_URL: join(directory, "url"),
      },
      encoding: "utf8",
    });
  return { directory, archive, script, asset, payload, run };
}

test.each(["x86_64", "aarch64"] as const)(
  "installs %s from another cwd into a relative path with spaces",
  (arch) => {
    const f = fixture(arch);
    const result = f.run(["--install-dir", "custom bin"]);
    expect(result.status, result.stderr).toBe(0);
    const destination = join(f.directory, "custom bin");
    expect(readFileSync(join(destination, "codex-code-mode-host"), "utf8")).toBe(f.payload);
    expect(statSync(join(destination, "codex-code-mode-host")).mode & 0o777).toBe(0o755);
    expect(
      existsSync(
        join(destination, "codex-code-mode-host-notices/rust-v0.145.0/licenses/manifest.json"),
      ),
    ).toBe(true);
    expect(readFileSync(join(f.directory, "url"), "utf8")).toContain(
      `/rust-v0.145.0/${f.asset}.tar.gz`,
    );
  },
);

test.each(["archive", "binary"])(
  "rejects a bad %s checksum before changing the destination",
  (stage) => {
    const f = fixture("x86_64");
    if (stage === "archive") writeFileSync(f.archive, "corrupt download");
    else
      writeFileSync(
        f.script,
        readFileSync(f.script, "utf8").replace(
          /code_mode_binary_sha=[a-f0-9]+/g,
          `code_mode_binary_sha=${"0".repeat(64)}`,
        ),
      );
    const destination = join(f.directory, "existing");
    mkdirSync(destination);
    writeFileSync(join(destination, "codex-code-mode-host"), "existing host");
    expect(f.run(["--install-dir", destination]).status).not.toBe(0);
    expect(readFileSync(join(destination, "codex-code-mode-host"), "utf8")).toBe("existing host");
    expect(existsSync(join(destination, "codex-code-mode-host-notices"))).toBe(false);
  },
);

test("help and invalid arguments do not download", () => {
  const f = fixture("x86_64");
  expect(f.run(["--help"]).status).toBe(0);
  for (const args of [["--install-dir"], ["--install-dir", ""], ["--unknown"]])
    expect(f.run(args).status).toBe(2);
  expect(existsSync(join(f.directory, "url"))).toBe(false);
});

test("relative script invocation with CDPATH installs the host and notices", () => {
  const f = fixture("x86_64");
  const result = f.run(["--install-dir", "custom bin"], ".:/tmp");
  expect(result.status, result.stderr).toBe(0);
  const destination = join(f.directory, "custom bin");
  expect(readFileSync(join(destination, "codex-code-mode-host"), "utf8")).toBe(f.payload);
  expect(
    readFileSync(join(destination, "codex-code-mode-host-notices/rust-v0.145.0/LICENSE"), "utf8"),
  ).toBe(readFileSync(join(root, "packages/ext/codex-adapter/vendor/code-mode/LICENSE"), "utf8"));
});
