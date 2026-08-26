import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { relative, resolve } from "node:path";

import { describe, expect, test } from "vitest";

const root = resolve(import.meta.dirname);
const retainedGroups = [
  /^(?:activation|apply-patch|exec-command|prompt-guidance|vendor-boundary|view-image)\.test\.ts$/,
  /^web-run\.test\.ts$/,
  /^(?:activation|index|native-binary-error|prompt-guidance)\.ts$/,
  /^(?:LICENSE|UPSTREAM\.md)$/,
  /^apply-patch\/(?:binary|executor|rendering|render-state|tool)\.ts$/,
  /^exec\/(?:binary|bridge-client|bridge-session|command-tool|format|output|results|session-manager|shell|wait|write-stdin-tool)\.ts$/,
  /^native\/runner\.ts$/,
  /^web-run\/(?:binary|tool)\.ts$/,
  /^view-image\/(?:binary|tool)\.ts$/,
  /^patch\/(?:parser|paths|types)\.ts$/,
  /^vendor\/apply-patch\/(?:Cargo\.(?:lock|toml)|LICENSE-APACHE-2\.0|LICENSE-path-absolutize|NOTICE)$/,
  /^vendor\/apply-patch\/crates\/(?:codex-apply-patch|codex-utils-absolute-path|codex-utils-path-uri|pi-apply-patch-fs)\/[^/]+$/,
  /^vendor\/exec\/(?:Cargo\.(?:lock|toml)|LICENSE-APACHE-2\.0|NOTICE)$/,
  /^vendor\/exec\/crates\/(?:codex-exec-shim|codex-utils-pty)\/[^/]+$/,
  /^vendor\/web-run\/(?:Cargo\.(?:lock|toml)|LICENSE-APACHE-2\.0|NOTICE|THIRD_PARTY_LICENSES\.html|UPSTREAM|about\.(?:hbs|toml))$/,
  /^vendor\/web-run\/src\/(?:cli|http|main|search|types)\.rs$/,
  /^vendor\/view-image\/(?:Cargo\.(?:lock|toml)|LICENSE-APACHE-2\.0|LICENSE-MIT|NOTICE|THIRD_PARTY_LICENSES\.html|UPSTREAM|about\.(?:hbs|toml))$/,
  /^vendor\/view-image\/view-image\/rust\/(?:Cargo\.toml|main\.rs)$/,
  /^vendor\/view-image\/rust\/crates\/codex-utils-image\/[^/]+$/,
];
const nativeArtifacts = [
  "apply-patch/bin/linux-x64/apply_patch",
  "exec/bin/linux-x64/exec_bridge",
  "view-image/bin/linux-x64/view_image",
  "web-run/bin/linux-x64/web_run",
];

function filesBelow(directory: string, relativeTo = root): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (!entry.isDirectory()) return [relative(relativeTo, path)];
    return entry.name === "target" ? [] : filesBelow(path, relativeTo);
  });
}

describe("Codex adapter vendor boundary", () => {
  test("ignores Cargo build output", () => {
    const fixture = mkdtempSync(resolve(tmpdir(), "pi-bites-vendor-boundary-"));
    try {
      mkdirSync(resolve(fixture, "target/debug"), { recursive: true });
      writeFileSync(resolve(fixture, "target/debug/artifact"), "ignored");
      writeFileSync(resolve(fixture, "retained.rs"), "retained");

      expect(filesBelow(fixture, fixture)).toEqual(["retained.rs"]);
    } finally {
      rmSync(fixture, { recursive: true });
    }
  });

  test("contains only retained source groups and Linux x64 artifacts", () => {
    const files = filesBelow(root);
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
        "vendor/view-image/LICENSE-APACHE-2.0",
        "vendor/view-image/LICENSE-MIT",
        "vendor/view-image/NOTICE",
        "vendor/view-image/THIRD_PARTY_LICENSES.html",
        "vendor/view-image/UPSTREAM",
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
    expect(sha256("view-image/bin/linux-x64/view_image")).toBe(
      "39fe04b7cb5a5060f2ab9b22c81ee2686e942964a1d7d3d0836bbfd5c5776deb",
    );
    expect(sha256("vendor/view-image/view-image/rust/main.rs")).toBe(
      "6d550c6dd63280fae5d9f492f3d56cf0c95d0e7fb4cb976bf4d48cda469485e3",
    );
    expect(sha256("vendor/view-image/rust/crates/codex-utils-image/lib.rs")).toBe(
      "0eb983b61097307f1156640c23e5923ec9bdfe372d5bbcc0cb6b8a97c31ccf92",
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

    const viewImageLockfile = readFileSync(resolve(root, "vendor/view-image/Cargo.lock"), "utf8");
    for (const dependency of ["codex-utils-cache", "lru", "mime_guess", "sha1", "tokio"]) {
      expect(viewImageLockfile).not.toContain(`name = "${dependency}"`);
    }

    const localViewImageSource = [
      "view-image/tool.ts",
      "vendor/view-image/view-image/rust/main.rs",
      "vendor/view-image/rust/crates/codex-utils-image/lib.rs",
    ]
      .map((path) => readFileSync(resolve(root, path), "utf8"))
      .join("\n");
    for (const forbidden of [
      "describeImageContentForTextModel",
      "resolveImageDescriptionModel",
      "parseSSE",
      "IMAGE_DESCRIPTION_MODEL",
      "input_image",
      "fetch(",
    ]) {
      expect(localViewImageSource).not.toContain(forbidden);
    }
  });
});
