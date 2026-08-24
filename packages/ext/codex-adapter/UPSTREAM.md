# Upstream provenance

The Codex adapter's `apply_patch`, `exec_command`, and `write_stdin` tools are owned in this repository and were adapted from:

- Package: `@howaboua/pi-codex-conversion` 3.0.18
- Repository: <https://github.com/IgorWarzocha/howaboua-pi-stuff>
- Commit: `e12067caadc38da4e785d0300202aac233ae3b2f`
- Package license: MIT, preserved in [`LICENSE`](LICENSE)

## Retained surface

The TypeScript parser, path rules, result types, native runner/error handling, executor, and tool behavior came from `packages/pi-codex-conversion/src/{patch,tools/apply-patch,tools/exec,tools/native}`. They were reduced to the direct `apply_patch`, structured `exec_command`, and `write_stdin` surfaces and adapted to Pi-bites paths and APIs. The local adapter uses Pi's existing provider, transport, model catalogue, authentication, configured shell, and core tools; it does not retain upstream provider registration, prompt conversion, Code Mode `exec`/`wait`, `web_run`, compaction, voice, image, or settings features.

Local integration changes include configuration-based provider matching, ownership-aware active-tool reconciliation, a Linux-x64-only binary locator, direct binary-path injection for failure tests, and nested use of the host's single-file mutation queue. The upstream collapsed/expanded patch diff and failure rendering is retained, with local sequencing for repeated targets and result-detail snapshots for restored rows. Patch parsing and execution remain delegated to the retained upstream parser and native implementation.

The structured shell tools retain the upstream JSON-lines bridge protocol, resumable session manager, bounded tail output, interruption and process-group cleanup. Their custom command-summary renderer and session tracker were omitted in favor of minimal Pi-native rendering. Pi's configured `shellPath` is snapshotted before asynchronous execution, and live TypeScript output buffers are capped at 1 MiB per process in addition to the native bridge's 8 MiB retained-output cap. The local read response adds `droppedBytes` accounting so output evicted at that native cap is represented in truncation metadata rather than silently lost.

## Native artifact

Only these upstream artifacts are retained:

- Path: `apply-patch/bin/linux-x64/apply_patch`
- Target: Linux x86-64
- SHA-256: `9ded1c635a4e0e2aae2dd09d7f676b24fc4b377016f74c1a51d8b3b22ed6bb55`
- Format: stripped, dynamically linked ELF 64-bit x86-64 executable

- Path: `exec/bin/linux-x64/exec_bridge`
- Target: Linux x86-64
- SHA-256: `a240c111fcf6a3efbfb8aef56fdea6c1aa24421c3fc4c28a6a2d6703266df6fe`
- Format: stripped, dynamically linked ELF 64-bit x86-64 executable

No macOS, Windows, Linux arm64, or unrelated native artifacts are included.

## Auditable source

The minimum Rust workspace needed to build and test `apply_patch` is in [`vendor/apply-patch`](vendor/apply-patch):

- `codex-apply-patch`, synced by the package from `openai/codex` commit `b545c94041017d000e2c8b2f6272705d21b85dfb`
- `codex-utils-absolute-path` and `codex-utils-path-uri`, synced from `openai/codex` commit `d36a3ead3c896d0552207763ef483262bce9ac73`
- `pi-apply-patch-fs`, the package's local host-filesystem adapter
- a reduced workspace manifest and lockfile

The unrelated shell/heredoc invocation detector is omitted; the retained standalone executable reads patch text directly, so its `tree-sitter` dependencies are omitted as well.

The minimum Rust workspace needed to rebuild `exec_bridge` is in [`vendor/exec`](vendor/exec). It contains only `codex-exec-shim`, the Linux-relevant `codex-utils-pty` source, a reduced workspace manifest, and a regenerated lockfile. Windows-only PTY source and dependencies are intentionally omitted. The package snapshot provenance, OpenAI Codex source commit, binary digest, Apache-2.0 license, and notice are preserved alongside that workspace. The unused upstream pushed-event backend was removed, and the polling response was extended with the local dropped-byte accounting described above.

OpenAI Codex's Apache-2.0 license and NOTICE are preserved as `LICENSE-APACHE-2.0` and `NOTICE`. `codex-utils-absolute-path/absolutize.rs` identifies its adaptation from `path-absolutize` 3.1.1; that MIT license is preserved as `LICENSE-path-absolutize`.

Build and test the retained source from the repository root:

```bash
cargo test --locked --manifest-path packages/ext/codex-adapter/vendor/apply-patch/Cargo.toml
cargo build --locked --release --bin apply_patch --manifest-path packages/ext/codex-adapter/vendor/apply-patch/Cargo.toml
cargo test --locked --manifest-path packages/ext/codex-adapter/vendor/exec/Cargo.toml
cargo build --locked --release --bin exec_bridge --manifest-path packages/ext/codex-adapter/vendor/exec/Cargo.toml
```

The rebuilt executables are written below their corresponding vendor workspace's `target/release` directory. The checked-in `apply_patch` ELF was imported from the package snapshot; `exec_bridge` was rebuilt from the retained, locally reduced source for Linux x86-64. The reduced lockfiles were regenerated for the pruned workspaces.

## Deliberate exclusions

The vendor does not contain Code Mode, Notebook Mode, custom provider or Responses Lite transport code, cached transport/prewarming, native compaction, web search, voice or dictation, GipPity, image generation/viewing, usage/settings/changelog UI, or binaries for targets other than Linux x86-64. The repository boundary test also rejects their known source-group names, unsupported native artifacts, changed binary digests, and upstream dependencies used only by removed features.

`tree-sitter-bash` and `web-tree-sitter` remain repository dependencies for Pi-bites' bash-gate parser; they are not retained for the adapter. No runtime dependency on `@howaboua/pi-codex-conversion` or OpenAI's SDK remains.

## Sync procedure

1. Record the new package version, package repository commit, and every nested OpenAI Codex source revision before copying anything.
2. Diff only the retained TypeScript groups and the two reduced Rust workspaces above. Port needed changes into the owned Pi-bites implementation; do not copy the upstream package wholesale.
3. Reapply the local integration changes documented under **Retained surface**, including provider-neutral activation, tool preservation, bounded output, lifecycle cleanup, and Linux-x64-only lookup.
4. Regenerate reduced Cargo lockfiles, run both locked Cargo test/build pairs, strip the Linux x86-64 executables, replace only the two documented artifacts, and update their SHA-256 values here and in `vendor-boundary.test.ts`.
5. Recheck all nested licenses/notices and update this file for source, dependency, binary, or divergence changes.
6. Run the focused adapter tests and `bun check`. The boundary test must pass before the sync is accepted.
