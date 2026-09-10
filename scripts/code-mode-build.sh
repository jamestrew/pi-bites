#!/usr/bin/env bash
# Build-time network access only; the installed adapter never downloads a host.
set -euo pipefail
case "${1:-}" in
  x64) target=x86_64-unknown-linux-musl; zig_target=x86_64-linux-musl ;;
  arm64) target=aarch64-unknown-linux-musl; zig_target=aarch64-linux-musl ;;
  *) echo 'Usage: bash scripts/code-mode-build.sh x64|arm64' >&2; exit 2 ;;
esac
root=$(builtin cd "$(dirname "$0")/.." >/dev/null && pwd -P)
vendor="$root/packages/ext/codex-adapter/vendor/code-mode"
if [[ $(rustc --version) != 'rustc 1.100.0-nightly (e457a7b0d 2026-08-27)' || $(zig version) != 0.15.2 ]]; then
  echo 'Use Rust nightly-2026-08-28 (with rust-src) and Zig 0.15.2; see vendor/code-mode/README.md.' >&2
  exit 1
fi
mkdir -p "$vendor/target/v8" "$vendor/target/linkers"
while read -r digest name; do
  if [[ ! -f "$vendor/target/v8/$name" ]]; then
    curl --fail --location --retry 3 "https://github.com/openai/codex/releases/download/rusty-v8-v149.2.0/$name" -o "$vendor/target/v8/$name"
  fi
done < "$vendor/v8-artifacts.sha256"
(cd "$vendor/target/v8" && sha256sum --check "$vendor/v8-artifacts.sha256")
linker="$vendor/target/linkers/$target"
cat > "$linker" <<EOF_LINKER
#!/usr/bin/env python3
import os, sys
# Zig does not accept this GCC workaround flag. Validation builds use QEMU;
# these outputs do not replace the upstream release artifacts automatically.
args = [arg for arg in sys.argv[1:] if arg != "-Wl,--fix-cortex-a53-843419"]
os.execvp("zig", ["zig", "cc", "-target", "$zig_target", *args])
EOF_LINKER
chmod +x "$linker"
export RUSTY_V8_ARCHIVE="$vendor/target/v8/librusty_v8_release_$target.a.gz"
export RUSTY_V8_SRC_BINDING_PATH="$vendor/target/v8/src_binding_release_$target.rs"
export RUSTFLAGS="-C link-self-contained=no -C strip=symbols --remap-path-prefix=$root=/pi-bites"
if [[ $target == aarch64* ]]; then
  export CARGO_TARGET_AARCH64_UNKNOWN_LINUX_MUSL_LINKER="$linker"
  if [[ $(uname -m) != aarch64 ]]; then
    export CARGO_TARGET_AARCH64_UNKNOWN_LINUX_MUSL_RUNNER=qemu-aarch64
  fi
else
  export CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER="$linker"
  if [[ $(uname -m) != x86_64 ]]; then
    export CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_RUNNER=qemu-x86_64
  fi
fi
args=(--locked --target "$target" -Z build-std=std,panic_abort --manifest-path "$vendor/Cargo.toml")
cargo test "${args[@]}"
cargo build "${args[@]}" --release --bin codex-code-mode-host
binary="$vendor/target/$target/release/codex-code-mode-host"
runner=()
if [[ $target == aarch64* && $(uname -m) != aarch64 ]]; then runner=(qemu-aarch64); fi
if [[ $target == x86_64* && $(uname -m) != x86_64 ]]; then runner=(qemu-x86_64); fi
python3 "$root/scripts/code-mode-smoke.py" "${runner[@]}" "$binary"
sha256sum "$binary"
echo 'Review the artifact and notices before installing it in the versioned user data directory; do not add executables to Git.'
