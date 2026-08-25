import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";

import { describe, expect, test } from "vitest";

const root = resolve(import.meta.dirname);
const retainedGroups = [
  /^(?:activation|apply-patch|exec-command|prompt-guidance|vendor-boundary)\.test\.ts$/,
  /^web-run\.test\.ts$/,
  /^(?:activation|index|native-binary-error|prompt-guidance)\.ts$/,
  /^(?:LICENSE|UPSTREAM\.md)$/,
  /^apply-patch\/(?:binary|executor|rendering|render-state|tool)\.ts$/,
  /^exec\/(?:binary|bridge-client|bridge-session|command-tool|format|output|results|session-manager|shell|wait|write-stdin-tool)\.ts$/,
  /^native\/runner\.ts$/,
  /^web-run\/(?:binary|tool)\.ts$/,
  /^patch\/(?:parser|paths|types)\.ts$/,
  /^vendor\/apply-patch\/(?:Cargo\.(?:lock|toml)|LICENSE-APACHE-2\.0|LICENSE-path-absolutize|NOTICE)$/,
  /^vendor\/apply-patch\/crates\/(?:codex-apply-patch|codex-utils-absolute-path|codex-utils-path-uri|pi-apply-patch-fs)\/[^/]+$/,
  /^vendor\/exec\/(?:Cargo\.(?:lock|toml)|LICENSE-APACHE-2\.0|NOTICE)$/,
  /^vendor\/exec\/crates\/(?:codex-exec-shim|codex-utils-pty)\/[^/]+$/,
  /^vendor\/web-run\/(?:Cargo\.(?:lock|toml)|LICENSE-APACHE-2\.0|NOTICE|THIRD_PARTY_LICENSES\.html|UPSTREAM|about\.(?:hbs|toml))$/,
  /^vendor\/web-run\/src\/(?:cli|http|main|search|types)\.rs$/,
];
const nativeArtifacts = [
  "apply-patch/bin/linux-x64/apply_patch",
  "exec/bin/linux-x64/exec_bridge",
  "web-run/bin/linux-x64/web_run",
];

function filesBelow(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? filesBelow(path) : [relative(root, path)];
  });
}

describe("Codex adapter vendor boundary", () => {
  test("contains only retained source groups and Linux x64 artifacts", () => {
    const files = filesBelow(root).filter((path) => !path.includes("/target/"));
    expect(
      files.filter(
        (path) =>
          !nativeArtifacts.includes(path) && !retainedGroups.some((group) => group.test(path)),
      ),
    ).toEqual([]);
    expect(
      files
        .filter((path) => {
          const bytes = readFileSync(resolve(root, path));
          return (
            path.includes("/bin/") ||
            /\.(?:dll|dylib|exe|node|so)$/.test(path) ||
            bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
          );
        })
        .sort(),
    ).toEqual(nativeArtifacts);
    expect(files).toEqual(
      expect.arrayContaining([
        "LICENSE",
        "UPSTREAM.md",
        "vendor/apply-patch/LICENSE-APACHE-2.0",
        "vendor/apply-patch/LICENSE-path-absolutize",
        "vendor/apply-patch/NOTICE",
        "vendor/exec/LICENSE-APACHE-2.0",
        "vendor/exec/NOTICE",
        "vendor/web-run/LICENSE-APACHE-2.0",
        "vendor/web-run/NOTICE",
        "vendor/web-run/THIRD_PARTY_LICENSES.html",
        "vendor/web-run/UPSTREAM",
      ]),
    );
  });

  test("pins the documented native artifacts and excludes upstream-only dependencies", () => {
    const sha256 = (path: string) =>
      createHash("sha256")
        .update(readFileSync(resolve(root, path)))
        .digest("hex");
    expect(sha256("apply-patch/bin/linux-x64/apply_patch")).toBe(
      "9ded1c635a4e0e2aae2dd09d7f676b24fc4b377016f74c1a51d8b3b22ed6bb55",
    );
    expect(sha256("exec/bin/linux-x64/exec_bridge")).toBe(
      "a240c111fcf6a3efbfb8aef56fdea6c1aa24421c3fc4c28a6a2d6703266df6fe",
    );
    expect(sha256("web-run/bin/linux-x64/web_run")).toBe(
      "6e827a6f3600f600d34755a8aa1c3878db0ad34ae2e3001a80c715ba7cf57e89",
    );

    const manifest = JSON.parse(readFileSync(resolve(root, "../../../package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    const removedFeatureDependencies = [
      "@howaboua/pi-codex-conversion",
      "js-tiktoken",
      "openai",
      "partial-json",
      "proxy-from-env",
      "selfsigned",
      "smol-toml",
      "undici",
      "unzipper",
      "ws",
      "zeromq",
    ];
    expect(
      removedFeatureDependencies.filter((name) => name in (manifest.dependencies ?? {})),
    ).toEqual([]);
  });
});
