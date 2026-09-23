#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
version=$(pi -v)

bun pm pkg set \
  "devDependencies.@earendil-works/pi-coding-agent=$version" \
  "devDependencies.@earendil-works/pi-server=$version" \
  "devDependencies.@earendil-works/pi-tui=$version" \
  'peerDependencies.@earendil-works/pi-coding-agent=*' \
  'peerDependencies.@earendil-works/pi-server=*' \
  'peerDependencies.@earendil-works/pi-tui=*'

bun install
