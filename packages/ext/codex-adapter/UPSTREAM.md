# Upstream provenance

The Codex adapter's `apply_patch`, `exec_command`, `write_stdin`, `view_image`, and `web_run` tools are owned in this repository and were adapted from:

- Package: `@howaboua/pi-codex-conversion` 3.0.18
- Repository: <https://github.com/IgorWarzocha/howaboua-pi-stuff>
- Commit: `e12067caadc38da4e785d0300202aac233ae3b2f`
- Package license: MIT, preserved in [`LICENSE`](LICENSE)

## Retained surface

The TypeScript parser, path rules, result types, native runner/error handling, executor, and tool behavior came from `packages/pi-codex-conversion/src/{patch,tools/apply-patch,tools/exec,tools/native,tools/view-image,tools/web-run}`. They were reduced to the direct `apply_patch`, structured `exec_command`, `write_stdin`, local-only `view_image`, and standalone `web_run` surfaces and adapted to Pi-bites paths and APIs. The local adapter uses Pi's existing provider, model catalogue, authentication, configured shell, and core tools; it does not retain upstream provider registration, prompt conversion, Code Mode `exec`/`wait`, compaction, voice, image generation/editing, model-generated image descriptions, or settings features.

Local integration changes include configuration-based provider matching, ownership-aware active-tool reconciliation, Linux x86-64/arm64 binary locators, direct binary-path injection for failure tests, and nested use of the host's single-file mutation queue. The upstream collapsed/expanded patch diff and failure rendering is retained, with local sequencing for repeated targets and result-detail snapshots for restored rows. Patch parsing and execution remain delegated to the retained upstream parser and native implementation.

The structured shell tools retain the upstream JSON-lines bridge protocol, resumable session manager, bounded tail output, interruption and process-group cleanup. Their custom command-summary renderer and session tracker were omitted in favor of minimal Pi-native rendering. Pi's configured `shellPath` is snapshotted before asynchronous execution, and live TypeScript output buffers are capped at 1 MiB per process in addition to the native bridge's 8 MiB retained-output cap. The local read response adds `droppedBytes` accounting so output evicted at that native cap is represented in truncation metadata rather than silently lost.

`web_run` retains only text search, image-result search, open, click, and find. Route policy and auth resolution are local TypeScript code: stock `openai-codex` Responses models are trusted directly, other Responses providers require the exact `webSearchProviders` allowlist, and stock Codex fallback requires the independent `allowOpenAICodexFallback` boolean. Every execution snapshots the active model and registry before awaiting `modelRegistry.getApiKeyAndHeaders`. The native process receives the selected endpoint and registry-derived headers; upstream auth-file parsing, token refresh, provider setup, and fallback are removed. Requests contain explicit tool operations plus a tool-owned navigation ID scoped to the session and selected route and rotated after 32 calls, selected model ID, fixed 8,000-token result budget, and search safety settings. They never contain Pi messages, prompts, project context, or unrelated tool results. Native HTTP connects within 15 seconds, has a 60-second request timeout, and rejects response bodies above 6 MiB before the host's independent 8 MiB process-output cap.

`view_image` retains only local helper execution and image-output parsing. It is registered with the adapter but selected only for in-scope models that declare image input. Its one-field schema accepts a local path (optionally prefixed by one `@`), snapshots the session working directory, and returns Pi's ordinary image content block. PNG, JPEG, and WebP are content-validated and preserved byte-for-byte; a decoded single-frame GIF is converted to PNG, while animated GIFs are rejected. Input is capped at 32 MiB, decoded dimensions at 4096 pixels per axis, and decoder allocation at 128 MiB. Pi owns image/fallback display. Upstream provider/auth lookup, Responses/SSE calls, generated descriptions, data-URL input, resizing policies, and image generation/editing are absent.

## Native artifact

Only these upstream artifacts are retained:

- Path: `apply-patch/bin/linux-x64/apply_patch`
- Target: Linux x86-64
- SHA-256: `9ded1c635a4e0e2aae2dd09d7f676b24fc4b377016f74c1a51d8b3b22ed6bb55`
- Format: stripped, dynamically linked ELF 64-bit x86-64 executable

- Path: `apply-patch/bin/linux-arm64/apply_patch`
- Target: Linux arm64
- Size: 917,568 bytes
- SHA-256: `0ce6c0c12fcadaa41143aee1c0de2c8be86cee4b1e7655391815c18f048c9518`
- Format: stripped, dynamically linked ELF 64-bit arm64 executable

- Path: `exec/bin/linux-x64/exec_bridge`
- Target: Linux x86-64
- SHA-256: `a240c111fcf6a3efbfb8aef56fdea6c1aa24421c3fc4c28a6a2d6703266df6fe`
- Format: stripped, dynamically linked ELF 64-bit x86-64 executable

- Path: `exec/bin/linux-arm64/exec_bridge`
- Target: Linux arm64
- Size: 1,114,176 bytes
- SHA-256: `78f499abb9821cd4cb2980ff2580682e55a4256981fc05db5c67416fb644c887`
- Format: stripped, dynamically linked ELF 64-bit arm64 executable

- Path: `web-run/bin/linux-x64/web_run`
- Target: Linux x86-64
- SHA-256: `6e827a6f3600f600d34755a8aa1c3878db0ad34ae2e3001a80c715ba7cf57e89`
- Format: stripped, dynamically linked ELF 64-bit x86-64 executable

- Path: `web-run/bin/linux-arm64/web_run`
- Target: Linux arm64
- Size: 2,687,040 bytes
- SHA-256: `be2de95f4d6ec29ea1d8a48ba0c3e363bfe3d26c116f5796eee2266c0d22e110`
- Format: stripped, dynamically linked ELF 64-bit arm64 executable

- Path: `view-image/bin/linux-x64/view_image`
- Target: Linux x86-64
- Size: 1,192,000 bytes
- SHA-256: `39fe04b7cb5a5060f2ab9b22c81ee2686e942964a1d7d3d0836bbfd5c5776deb`
- Format: stripped, dynamically linked ELF 64-bit x86-64 executable

- Path: `view-image/bin/linux-arm64/view_image`
- Target: Linux arm64
- Size: 1,114,176 bytes
- SHA-256: `951ceb39bfd09173816b392f75988b65a20bf6ed8a77d51a83d4747ba45e781d`
- Format: stripped, dynamically linked ELF 64-bit arm64 executable

No macOS, Windows, or unrelated native artifacts are included.

## Auditable source

The minimum Rust workspace needed to build and test `apply_patch` is in [`vendor/apply-patch`](vendor/apply-patch):

- `codex-apply-patch`, synced by the package from `openai/codex` commit `b545c94041017d000e2c8b2f6272705d21b85dfb`
- `codex-utils-absolute-path` and `codex-utils-path-uri`, synced from `openai/codex` commit `d36a3ead3c896d0552207763ef483262bce9ac73`
- `pi-apply-patch-fs`, the package's local host-filesystem adapter
- a reduced workspace manifest and lockfile

The unrelated shell/heredoc invocation detector is omitted; the retained standalone executable reads patch text directly, so its `tree-sitter` dependencies are omitted as well.

The minimum Rust workspace needed to rebuild `exec_bridge` is in [`vendor/exec`](vendor/exec). It contains only `codex-exec-shim`, the Linux-relevant `codex-utils-pty` source, a reduced workspace manifest, and a regenerated lockfile. Windows-only PTY source and dependencies are intentionally omitted. The package snapshot provenance, OpenAI Codex source commit, binary digest, Apache-2.0 license, and notice are preserved alongside that workspace. The unused upstream pushed-event backend was removed, and the polling response was extended with the local dropped-byte accounting described above.

The minimum standalone Rust crate needed to rebuild `web_run` is in [`vendor/web-run`](vendor/web-run). It retains the package's CLI, typed search request/response contract, request builder, and HTTP client, adapted from OpenAI Codex commit `b545c94041017d000e2c8b2f6272705d21b85dfb`. The local crate removes OAuth/auth-file access, token refresh, agent identity, Cloudflare cookie storage, environment-selected providers, dormant conversation-history code, and unsupported finance/weather/sports/time/screenshot operations. Its reduced lockfile, Apache-2.0 license, upstream NOTICE, nested `UPSTREAM` record, and generated Linux dependency-license bundle are checked in. `about.toml` and `about.hbs` regenerate that bundle with cargo-about.

The minimum Rust workspace needed to rebuild `view_image` is in [`vendor/view-image`](vendor/view-image). It retains the package's local-file CLI and the original-mode PNG/JPEG/WebP/GIF path from `codex-utils-image`, whose nested source provenance is OpenAI Codex commit `b545c94041017d000e2c8b2f6272705d21b85dfb`. The local reduction removes data-URL parsing, resize modes and calculations, the cross-call image cache, and the `codex-utils-cache`, `lru`, `sha1`, `mime_guess`, and `tokio` dependencies. The reduced lockfile, package MIT license, OpenAI Apache-2.0 license and notice, nested `UPSTREAM` records, and generated Linux dependency-license bundle are checked in. `about.toml` and `about.hbs` regenerate that bundle with cargo-about.

OpenAI Codex's Apache-2.0 license and NOTICE are preserved as `LICENSE-APACHE-2.0` and `NOTICE`. `codex-utils-absolute-path/absolutize.rs` identifies its adaptation from `path-absolutize` 3.1.1; that MIT license is preserved as `LICENSE-path-absolutize`.

Build and test the retained source from the repository root:

```bash
cargo test --locked --manifest-path packages/ext/codex-adapter/vendor/apply-patch/Cargo.toml
cargo build --locked --release --bin apply_patch --manifest-path packages/ext/codex-adapter/vendor/apply-patch/Cargo.toml
cargo test --locked --manifest-path packages/ext/codex-adapter/vendor/exec/Cargo.toml
cargo build --locked --release --bin exec_bridge --manifest-path packages/ext/codex-adapter/vendor/exec/Cargo.toml
cargo test --locked --manifest-path packages/ext/codex-adapter/vendor/web-run/Cargo.toml
cargo build --locked --release --bin web_run --manifest-path packages/ext/codex-adapter/vendor/web-run/Cargo.toml
cargo test --locked --manifest-path packages/ext/codex-adapter/vendor/view-image/Cargo.toml
cargo build --locked --release --bin view_image --manifest-path packages/ext/codex-adapter/vendor/view-image/Cargo.toml
nix run nixpkgs#cargo-about -- generate --locked --target x86_64-unknown-linux-gnu --fail --manifest-path packages/ext/codex-adapter/vendor/web-run/Cargo.toml --config packages/ext/codex-adapter/vendor/web-run/about.toml packages/ext/codex-adapter/vendor/web-run/about.hbs -o packages/ext/codex-adapter/vendor/web-run/THIRD_PARTY_LICENSES.html
sed -i 's/[[:space:]]\+$//' packages/ext/codex-adapter/vendor/web-run/THIRD_PARTY_LICENSES.html
nix run nixpkgs#cargo-about -- generate --locked --target x86_64-unknown-linux-gnu --fail --manifest-path packages/ext/codex-adapter/vendor/view-image/Cargo.toml --config packages/ext/codex-adapter/vendor/view-image/about.toml packages/ext/codex-adapter/vendor/view-image/about.hbs -o packages/ext/codex-adapter/vendor/view-image/THIRD_PARTY_LICENSES.html
sed -i 's/[[:space:]]\+$//' packages/ext/codex-adapter/vendor/view-image/THIRD_PARTY_LICENSES.html
```

The rebuilt executables are written below their corresponding vendor workspace's `target/release` directory. The checked-in `apply_patch` ELF was imported from the package snapshot; `exec_bridge`, `web_run`, and `view_image` were rebuilt from retained, locally reduced source for Linux x86-64. The package snapshot's original 1,610,072-byte `view_image` artifact (`5b58243a8a64d926b6175b463017cdbbdda771ffc6da136eedeebeba80a33c23`) was replaced so the checked-in executable corresponds to the pruned source. The reduced lockfiles were regenerated for the pruned workspaces.

The retained `web_run` and `view_image` were built with rustc `1.100.0-nightly (c656540d6 2026-08-21)`, Cargo `1.100.0-nightly (514c56dd7 2026-08-19)`, GNU ld 2.46, and glibc 2.42. The Nix-built ELF interpreters were made portable with patchelf 0.15.2 before copying the artifacts:

```sh
nix shell nixpkgs#patchelf -c patchelf --set-interpreter /lib64/ld-linux-x86-64.so.2 packages/ext/codex-adapter/vendor/web-run/target/release/web_run
nix shell nixpkgs#patchelf -c patchelf --set-interpreter /lib64/ld-linux-x86-64.so.2 packages/ext/codex-adapter/vendor/view-image/target/release/view_image
```

The resulting binaries require symbols only through GLIBC 2.34. Builds made under Nix must apply the same interpreter change before replacing a checked-in artifact.

The Linux arm64 artifacts were cross-compiled against glibc 2.34 with the NixOS 22.05 `pkgsCross.aarch64-multiplatform` toolchain. The nightly Rust installation used here includes `rust-src`, so Cargo can build the arm64 standard library without installing another target:

```sh
export CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=aarch64-unknown-linux-gnu-gcc
export CC_aarch64_unknown_linux_gnu=aarch64-unknown-linux-gnu-gcc
export AR_aarch64_unknown_linux_gnu=aarch64-unknown-linux-gnu-ar
cargo build --locked --release --target aarch64-unknown-linux-gnu -Z build-std=std,panic_abort --bin <binary> --manifest-path <workspace>/Cargo.toml
nix shell nixpkgs#patchelf -c patchelf --set-interpreter /lib/ld-linux-aarch64.so.1 <workspace>/target/aarch64-unknown-linux-gnu/release/<binary>
```

Run those commands inside a shell containing both `github:NixOS/nixpkgs/nixos-22.05#pkgsCross.aarch64-multiplatform.stdenv.cc` and `github:NixOS/nixpkgs/nixos-22.05#pkgsCross.aarch64-multiplatform.stdenv.cc.bintools.bintools`. Build each of the four binaries and copy it into the corresponding `bin/linux-arm64` directory. The arm64 artifacts also require symbols only through GLIBC 2.34.

## Deliberate exclusions

The vendor does not contain Code Mode, Notebook Mode, custom provider or Responses Lite transport code, cached transport/prewarming, native compaction, conversation-history forwarding, voice or dictation, GipPity, image generation/editing, remote image descriptions, usage/settings/changelog UI, or binaries for targets other than Linux x86-64 and arm64. The repository boundary test also rejects their known source-group names, unsupported native artifacts, changed binary digests, and upstream dependencies used only by removed features.

`tree-sitter-bash` and `web-tree-sitter` remain repository dependencies for Pi-bites' bash-gate parser; they are not retained for the adapter. No runtime dependency on `@howaboua/pi-codex-conversion` or OpenAI's SDK remains.

## Sync procedure

1. Record the new package version, package repository commit, and every nested OpenAI Codex source revision before copying anything.
2. Diff only the retained TypeScript groups and the four reduced Rust workspaces above. Port needed changes into the owned Pi-bites implementation; do not copy the upstream package wholesale.
3. Reapply the local integration changes documented under **Retained surface**, including provider-neutral activation, tool preservation, bounded output, lifecycle cleanup, and supported Linux architecture lookup.
4. Regenerate reduced Cargo lockfiles, run all locked Cargo test/build pairs, strip the Linux x86-64 and arm64 executables, replace only the eight documented artifacts, and update their SHA-256 values here and in `vendor-boundary.test.ts`.
5. Recheck all nested licenses/notices and update this file for source, dependency, binary, or divergence changes.
6. Run the focused adapter tests and `bun check`. The boundary test must pass before the sync is accepted.
