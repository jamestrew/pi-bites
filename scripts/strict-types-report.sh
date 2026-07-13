#!/usr/bin/env bash
set -euo pipefail

report=$(mktemp)
errors=$(mktemp)
trap 'rm -f "$report" "$errors"' EXIT

paths=("$@")
if ((${#paths[@]} == 0)); then
  paths=(.)
fi

bunx oxlint "${paths[@]}" -f json >"$report" 2>"$errors" || true

if ! jq -e '.diagnostics | arrays' "$report" >/dev/null 2>&1; then
  cat "$errors" >&2
  echo "oxlint did not produce a valid JSON report" >&2
  exit 1
fi

jq -r '
  .diagnostics as $diagnostics
  | "Total diagnostics: \($diagnostics | length)",
    "",
    "By rule:",
    ($diagnostics
      | group_by(.code)
      | sort_by(-length)
      | .[]
      | "\(length)\t\(.[0].code)"),
    "",
    "By file:",
    ($diagnostics
      | group_by(.filename)
      | sort_by(-length, .[0].filename)
      | .[]
      | "\(length)\t\(.[0].filename)")
' "$report"
