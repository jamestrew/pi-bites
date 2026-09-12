#!/usr/bin/env bash
# Explicit installation only; Pi never runs this script automatically.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: code-mode-install.sh [--install-dir DIR]

Download and verify the pinned Code Mode host for Linux x64 or arm64.
Install codex-code-mode-host in DIR (default: ~/.local/bin), with license
notices under DIR/codex-code-mode-host-notices/rust-v0.145.0.
Add DIR to Pi's PATH, then restart Pi if its environment changed.

Options:
  --install-dir DIR  Directory for the executable (absolute or relative).
  -h, --help         Show this help without downloading anything.
EOF
}

code_mode_install_dir="$HOME/.local/bin"
while (($#)); do
  case "$1" in
    --install-dir)
      if (($# < 2)) || [[ -z "$2" || "$2" == --* ]]; then
        echo '--install-dir requires a directory' >&2
        exit 2
      fi
      code_mode_install_dir="$2"
      shift 2
      ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'Unknown argument: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done
# Resolve relative destinations before locating the repository's notices.
code_mode_install_dir="$(realpath -m -- "$code_mode_install_dir")"
# CDPATH can redirect relative cd and print its destination into this substitution.
code_mode_root=$(CDPATH= builtin cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && builtin pwd -P)
code_mode_vendor="$code_mode_root/packages/ext/codex-adapter/vendor/code-mode"

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)
    code_mode_target=x86_64-unknown-linux-musl
    code_mode_archive_sha=ac23177956c30cc1f9f180c27bd80f5bb5b76780db55fb94dcc22644d490852e
    code_mode_binary_sha=60bf16414be5333f09ff082540082304c7352931ef64bdeb170d4c35a82e6ef8
    ;;
  Linux-aarch64)
    code_mode_target=aarch64-unknown-linux-musl
    code_mode_archive_sha=22b5862c7206bc944f59402dbab4b4169e381ae8a68f0144a9ba7b61bcf3dd39
    code_mode_binary_sha=de29626fbdd921920bde5a76ec8e61cb837ce25e8d8853aace6001ca452e9c40
    ;;
  *) echo "Code Mode requires Linux x64 or arm64" >&2; exit 1 ;;
esac
code_mode_download=$(mktemp -d)
trap 'rm -rf "$code_mode_download"' EXIT
code_mode_asset="codex-code-mode-host-$code_mode_target"
curl --fail --location --retry 3 \
  "https://github.com/openai/codex/releases/download/rust-v0.145.0/$code_mode_asset.tar.gz" \
  -o "$code_mode_download/host.tar.gz"
printf '%s  %s\n' "$code_mode_archive_sha" "$code_mode_download/host.tar.gz" | sha256sum --check -
tar -xzf "$code_mode_download/host.tar.gz" -C "$code_mode_download" "$code_mode_asset"
printf '%s  %s\n' "$code_mode_binary_sha" "$code_mode_download/$code_mode_asset" | sha256sum --check -
code_mode_notices="$code_mode_install_dir/codex-code-mode-host-notices/rust-v0.145.0"
mkdir -p -- "$code_mode_notices"
cp -- "$code_mode_vendor"/{LICENSE,NOTICE,THIRD_PARTY_LICENSES.html} "$code_mode_notices/"
cp -R -- "$code_mode_vendor/licenses/." "$code_mode_notices/licenses"
cp -- "$code_mode_root/packages/ext/codex-adapter/LICENSE" "$code_mode_notices/LICENSE-conversion-MIT"
install -m 755 -- "$code_mode_download/$code_mode_asset" "$code_mode_install_dir/codex-code-mode-host"
printf 'Installed %s\nNotices: %s\n' "$code_mode_install_dir/codex-code-mode-host" "$code_mode_notices"
printf 'Ensure %s is on Pi’s PATH, then run /reload (or restart Pi after changing PATH).\n' "$code_mode_install_dir"
