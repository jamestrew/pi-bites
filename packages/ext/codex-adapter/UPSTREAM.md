# Upstream provenance

The `apply_patch` tracer bullet is owned in this repository and was adapted from:

- Package: `@howaboua/pi-codex-conversion` 3.0.18
- Repository: <https://github.com/IgorWarzocha/howaboua-pi-stuff>
- Commit: `e12067caadc38da4e785d0300202aac233ae3b2f`
- Package license: MIT, preserved in [`LICENSE`](LICENSE)

## Retained surface

The TypeScript parser, path rules, result types, native runner/error handling, executor, and tool behavior came from `packages/pi-codex-conversion/src/{patch,tools/apply-patch,tools/native}`. They were reduced to the direct `apply_patch` surface and adapted to Pi-bites paths and APIs. The local adapter uses Pi's existing provider, transport, model catalogue, authentication, and core tools; it does not retain upstream provider registration, prompt conversion, code mode, shell-session tools, `web_run`, compaction, voice, image, or settings features.

Local integration changes include configuration-based provider matching, ownership-aware active-tool reconciliation, a Linux-x64-only binary locator, direct binary-path injection for failure tests, and nested use of the host's single-file mutation queue. The upstream collapsed/expanded patch diff and failure rendering is retained, with local sequencing for repeated targets and result-detail snapshots for restored rows. Patch parsing and execution remain delegated to the retained upstream parser and native implementation.

## Native artifact

Only this upstream artifact is retained:

- Path: `apply-patch/bin/linux-x64/apply_patch`
- Target: Linux x86-64
- SHA-256: `9ded1c635a4e0e2aae2dd09d7f676b24fc4b377016f74c1a51d8b3b22ed6bb55`
- Format: stripped, dynamically linked ELF 64-bit x86-64 executable

No macOS, Windows, Linux arm64, or unrelated native artifacts are included.

## Auditable source

The minimum Rust workspace needed to build and test `apply_patch` is in [`vendor/apply-patch`](vendor/apply-patch):

- `codex-apply-patch`, synced by the package from `openai/codex` commit `b545c94041017d000e2c8b2f6272705d21b85dfb`
- `codex-utils-absolute-path` and `codex-utils-path-uri`, synced from `openai/codex` commit `d36a3ead3c896d0552207763ef483262bce9ac73`
- `pi-apply-patch-fs`, the package's local host-filesystem adapter
- a reduced workspace manifest and lockfile

The unrelated shell/heredoc invocation detector is omitted; the retained standalone executable reads patch text directly, so its `tree-sitter` dependencies are omitted as well.

OpenAI Codex's Apache-2.0 license and NOTICE are preserved as `LICENSE-APACHE-2.0` and `NOTICE`. `codex-utils-absolute-path/absolutize.rs` identifies its adaptation from `path-absolutize` 3.1.1; that MIT license is preserved as `LICENSE-path-absolutize`.

Build and test the retained source from the repository root:

```bash
cargo test --locked --manifest-path packages/ext/codex-adapter/vendor/apply-patch/Cargo.toml
cargo build --locked --release --bin apply_patch --manifest-path packages/ext/codex-adapter/vendor/apply-patch/Cargo.toml
```

The rebuilt executable is written to `packages/ext/codex-adapter/vendor/apply-patch/target/release/apply_patch`. The checked-in ELF is the artifact imported from the package snapshot above; the reduced lockfile was regenerated for this pruned workspace, so byte-for-byte reproduction is not asserted.
