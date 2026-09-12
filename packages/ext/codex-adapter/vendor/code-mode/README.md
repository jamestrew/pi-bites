# Standalone Code Mode host packaging

This workspace builds the standalone stdio host used by the default scoped Code Mode adapter. Pi-side lifecycle, delegation and rendering remain outside the vendored Rust source.

## Source boundary

- Codex: `rust-v0.145.0`, commit `25af12f7e61572b0bc18ddb1008be543b91519b0`.
- Conversion: `@howaboua/pi-codex-conversion` 3.0.31, commit
  `94eb6c0745e2f516bf19603f912f7b6478b43355`.
- `crates/{code-mode,code-mode-host,code-mode-protocol}/src` are exact copies of
  `codex-rs/<crate>/src` at the Codex pin, including its tests. Conversion omitted
  those test files despite retaining their module declarations; they are restored here.
- `crates/codex-protocol/src/tool_name.rs` is the pinned Codex
  `codex-rs/protocol/src/tool_name.rs`. Its tiny `lib.rs` and the reduced manifests
  come from conversion's `code-mode/vendor/code-mode-src`. The manifests add only
  the upstream test dependencies, `pretty_assertions` and Tokio `test-util`.
- `Cargo.lock` is pruned from **Codex's pinned lockfile**, not conversion's newer
  dependency resolutions. All registry name/version/checksum triples match that
  upstream lockfile. The four local package versions are packaging-only `0.0.0`.
- `code-mode/vendor-inventory.json` lists every retained vendor file and SHA-256;
  the adapter boundary test rejects extra files, absent files, and changed content.

The runtime contains its upstream in-process evaluator and remote-session library
modules because those are part of this matched crate and its tests. There is no
Codex core/product crate, Notebook, TOML discovery, telemetry integration, voice,
provider registration, or Pi-specific source in these upstream source trees.

To audit source identity with a Codex checkout, compare each retained crate's `src`
recursively with `git archive 25af12f7e61572b0bc18ddb1008be543b91519b0 codex-rs/<crate>/src`.
Compare the ToolName file separately with `codex-rs/protocol/src/tool_name.rs`.
Do not use the checkout's current HEAD as the source pin.

## Required host dependency

The host is installed manually from **unmodified official Codex release assets** at
`https://github.com/openai/codex/releases/download/rust-v0.145.0/`.
Executables are not tracked in this repository. Source, checksums, notices and
build instructions remain here. Downloads run only through the explicit installer script; there is no automatic
download or conversion-package dependency.

| Linux architecture | Bytes | SHA-256 |
| --- | ---: | --- |
| x64 | 46,139,288 | `60bf16414be5333f09ff082540082304c7352931ef64bdeb170d4c35a82e6ef8` |
| arm64 | 43,502,544 | `de29626fbdd921920bde5a76ec8e61cb837ce25e8d8853aace6001ca452e9c40` |

| Release archive | SHA-256 |
| --- | --- |
| `codex-code-mode-host-x86_64-unknown-linux-musl.tar.gz` | `ac23177956c30cc1f9f180c27bd80f5bb5b76780db55fb94dcc22644d490852e` |
| `codex-code-mode-host-aarch64-unknown-linux-musl.tar.gz` | `22b5862c7206bc944f59402dbab4b4169e381ae8a68f0144a9ba7b61bcf3dd39` |

Both are stripped static ELF executables (x64 static PIE). They require no ELF
interpreter, shared glibc, Node native addon, external ICU data, or external V8
snapshot at runtime. Linux must permit V8's JIT memory mappings and threads.
They provide the native evaluator, not a filesystem/network sandbox for delegated
tools. Other operating systems and architectures fail explicitly.

`code-mode/binary.ts` resolves the first executable file named
`codex-code-mode-host` on Pi's `PATH`, including symlinks. Any directory on
`PATH` is supported; there is no fallback to a fixed installation directory.
Use the pinned release above; PATH lookup does not verify release identity or
checksums. Its bounded, five-second packaging probe negotiates protocol
v1 and waits for a clean process exit after EOF. Lookup rejects a missing executable; the probe rejects malformed/oversized/incompatible handshakes, crashes and hangs with
manual installation instructions and an explicit disable escape hatch. It never changes tool dialects.
The session-owned connection negotiates on its own live process;
this packaging probe is not a cached guarantee that a future process is healthy.

## Manual installation

Run the [installer](../../../../../scripts/code-mode-install.sh) from the repository root:

```bash
bash scripts/code-mode-install.sh
# Or choose the directory for the executable:
bash scripts/code-mode-install.sh --install-dir "$HOME/bin"
```

The default destination is `~/.local/bin`. Relative destinations resolve against
your current working directory; the script itself can be invoked from any directory.
Use `--help` for usage. The installer downloads only the current Linux architecture,
verifies both the archive and executable before installation, and installs
`codex-code-mode-host` directly in the chosen directory. Redistribution notices
are retained under `<install-dir>/codex-code-mode-host-notices/rust-v0.145.0/`.
It requires Bash, `curl`, `tar`, `sha256sum`, `realpath`, and standard coreutils.

Ensure the chosen directory is on Pi's `PATH`, then run `/reload`. If you changed
`PATH` in your shell, restart Pi from that environment. The installer does not
edit shell configuration. Existing installations in a versioned data directory
can still be added to `PATH` or linked into a directory already on it.

Rerunning the script replaces the executable in the chosen directory. To uninstall,
remove that executable and its `codex-code-mode-host-notices` directory.
For an offline installation, transfer the matching release archive and notices
from another machine, verify the archive and executable against the checksums
above, and install the executable in a directory on `PATH`.
No `postinstall` hook or first-use network request runs in Pi.

The normal `bun check` suite uses temporary executable fixtures and needs neither
a downloaded host nor external network access for Code Mode; native integration tests skip when no host exists. Tests of the bundled web client use a local HTTP server. To smoke-test a real installed
host from the repository root:

```bash
python3 scripts/code-mode-smoke.py "$(command -v codex-code-mode-host)"
```

## V8 and native notices

The locked `v8` crate is exactly **149.2.0**, with `deno_core_icudata` **0.77.0**.
Codex's Linux release build uses **Codex-built** V8 archive/binding pairs from
`rusty-v8-v149.2.0`, not the crate's default Deno downloads. Their four checksums
are retained in `v8-artifacts.sha256`. Do not mix versions or enable the separate
`ptrcomp_sandbox` artifact family: the selected Cargo release uses the plain
`release` pair and default crate features.

The archive contains V8 **14.9.207.2**, Chromium's custom libc++ ABI, libc++abi and
LLVM libc objects. Exact native source revisions are recorded in
[`licenses/manifest.json`](licenses/manifest.json), including ICU, Abseil,
Highway, Dragonbox, FP16, fast_float, simdutf and the V8 subtree notices.
The source provenance is Codex's pinned `MODULE.bazel`,
`patches/v8_module_deps.patch` and `third_party/v8/README.md`.
The full native build graph remains available at that Codex commit rather than
being copied with unrelated Codex product dependencies into this workspace.

Preserve `LICENSE` (Codex Apache-2.0), `NOTICE`, the adapter's conversion MIT
license, `THIRD_PARTY_LICENSES.html` (locked Rust dependency license texts), and
**all of `licenses/`** alongside binary redistribution. The native notice bundle
is deliberately conservative: it includes V8 subtree notices even when a linker
may discard the associated code. The crate's MIT license alone does not cover
V8/native distribution. LLVM's exceptions and all relevant BSD/MIT/Unicode
copyright and attribution text are retained, not replaced by SPDX labels.

The official host was built with Rust **1.95.0**. Rust's copyright/license texts, its complete `COPYRIGHT-library.html` bundle,
and musl's copyright text are retained as well. Upstream's release workflow
installs musl through apt without pinning a package version; its precise musl
build revision is not published. The musl notice is retained from v1.2.5, not
presented as proof that the release used that version. Consequently these
upstream artifacts have verified release/source provenance; **we do not claim a
byte-for-byte reproduction of the upstream release** from this reduced workspace.

## Rebuild and validation

A source rebuild is separate from reproducing upstream release bytes. The reduced
workspace omits workspace-wide release feature unification and product packaging.
A successful rebuild must be smoke-tested and its new checksum recorded before
replacing a installed executable.

The reproducible input recipe in `scripts/code-mode-build.sh` uses:

- Rust nightly **2026-08-28**, `rustc 1.100.0-nightly (e457a7b0d 2026-08-27)`,
  with `rust-src`; `-Z build-std` provides the two musl target standard libraries.
- Zig **0.15.2** for the musl linker/CRT and unwind runtime.
- The retained Cargo lockfile and checksum-verified Codex V8 archive/binding pairs.
- QEMU for execution when the target architecture differs from the build machine.

From the repository root, with the specified Rust toolchain on PATH:

```sh
nix shell github:NixOS/nixpkgs/9fbb54b33e91ee4ca368e35a78e0613c720600b3#zig_0_15 github:NixOS/nixpkgs/9fbb54b33e91ee4ca368e35a78e0613c720600b3#qemu -c bash scripts/code-mode-build.sh x64
nix shell github:NixOS/nixpkgs/9fbb54b33e91ee4ca368e35a78e0613c720600b3#zig_0_15 github:NixOS/nixpkgs/9fbb54b33e91ee4ca368e35a78e0613c720600b3#qemu -c bash scripts/code-mode-build.sh arm64
```

The script runs locked tests, a locked release build, and the framed-protocol/V8
smoke. Downloads occur only during this explicit maintainer build. Artifacts land
under `target/<target>/release`. The Zig validation linker omits Rust's
`--fix-cortex-a53-843419` GCC flag, which Zig does not support. These validation
outputs are **not automatically substituted for the official release artifacts**;
use upstream's musl GCC release workflow when that hardware workaround is needed.

For a native GNU build without the cross toolchain:

```sh
cargo test --locked --manifest-path packages/ext/codex-adapter/vendor/code-mode/Cargo.toml
cargo build --locked --release --manifest-path packages/ext/codex-adapter/vendor/code-mode/Cargo.toml
python3 scripts/code-mode-smoke.py packages/ext/codex-adapter/vendor/code-mode/target/release/codex-code-mode-host
```

The GNU recipe uses the v8 crate's default archive unless the two
`RUSTY_V8_*` overrides are supplied. It validates the retained source, not the
exact native dependency distribution of the pinned musl release.

Regenerate the Rust dependency notice bundle for each target (the Linux target
crate/license sets agree; generated whitespace can differ), then review any change to the native notice manifest:

```sh
nix run nixpkgs#cargo-about -- generate --locked --target x86_64-unknown-linux-musl --fail --manifest-path packages/ext/codex-adapter/vendor/code-mode/Cargo.toml --config packages/ext/codex-adapter/vendor/code-mode/about.toml packages/ext/codex-adapter/vendor/code-mode/about.hbs -o packages/ext/codex-adapter/vendor/code-mode/THIRD_PARTY_LICENSES.html
```

Native notice URLs and hashes are recorded per file (the standard-library bundle
is extracted from the checksum-verified Rust distribution member recorded there); Chromium `?format=TEXT`
responses must be base64-decoded. Fetch native notices only from the recorded
revisions, and retain their original text.

Validation on 2026-09-09: official x64 protocol/V8 smoke ran directly on Linux x64;
official arm64 protocol/V8 smoke ran locally through QEMU. Both negotiated v1,
opened a session, evaluated `text(6 * 7)` as `42`, shut down and exited cleanly.
The retained native tests pass on x64 and under arm64 QEMU (122 tests each).
No native arm64 hardware or CI execution is claimed.

Refresh the bounded vendor inventory after a reviewed vendor change:

```sh
python3 - <<'PY_INVENTORY'
import hashlib, json, pathlib
root = pathlib.Path("packages/ext/codex-adapter/vendor/code-mode")
files = {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
         for p in sorted(root.rglob("*")) if p.is_file() and "target" not in p.parts}
output = root.parents[1] / "code-mode/vendor-inventory.json"
output.write_text(json.dumps(files, indent=2) + "\n")
print(hashlib.sha256(output.read_bytes()).hexdigest())
PY_INVENTORY
```

Update the inventory digest in `vendor-boundary.test.ts` to the printed value.
The native source and license files are excluded from automatic formatting to
preserve upstream bytes (including upstream whitespace in notices).
