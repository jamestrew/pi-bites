#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
version=$(pi -v)

bun update --latest \
  "@earendil-works/pi-coding-agent@$version" \
  "@earendil-works/pi-tui@$version"

bun pm pkg set \
  'peerDependencies.@earendil-works/pi-coding-agent=*' \
  'peerDependencies.@earendil-works/pi-tui=*'
