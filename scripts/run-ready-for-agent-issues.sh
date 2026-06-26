#!/usr/bin/env bash
set -euo pipefail

REPO="jamestrew/pi-bites"
LIMIT=0
LABEL="ready-for-agent"
BASE_BRANCH="master"
REVIEW_SKILL="/home/jt/.agents/skills/thermonuclear-review/SKILL.md"
HANDOFF_SKILL="/home/jt/.agents/skills/handoff/SKILL.md"
PI_ARGS=(--print --approve --yolo)

usage() {
  cat <<USAGE
Usage: $0 [--limit N] [--repo OWNER/REPO] [--label LABEL] [--base BRANCH] [--review-skill PATH] [--handoff-skill PATH] [--pi-arg ARG ...]

Find open ready-for-agent issues for this repo that are not blocked by any open
native GitHub blocking relationship, then run a non-interactive pi
implementation/review/fix/PR pipeline for each issue.

Options:
  -n, --limit N        Maximum number of issues to work on (default: no cap)
  -R, --repo REPO      GitHub repo (default: $REPO)
  -l, --label LABEL    Ready label (default: $LABEL; also falls back to read-for-agent)
  -b, --base BRANCH    Base branch for work branches/PRs (default: $BASE_BRANCH)
  --review-skill PATH  Thermo-nuclear review skill path (default: $REVIEW_SKILL)
  --handoff-skill PATH Handoff skill path (default: $HANDOFF_SKILL)
  --pi-arg ARG         Extra argument passed to every pi invocation (repeatable)
  -h, --help           Show this help

Requires: gh, jq, jj, pi
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -n|--limit)
      LIMIT="${2:?missing value for $1}"; shift 2 ;;
    -R|--repo)
      REPO="${2:?missing value for $1}"; shift 2 ;;
    -l|--label)
      LABEL="${2:?missing value for $1}"; shift 2 ;;
    -b|--base)
      BASE_BRANCH="${2:?missing value for $1}"; shift 2 ;;
    --review-skill)
      REVIEW_SKILL="${2:?missing value for $1}"; shift 2 ;;
    --handoff-skill)
      HANDOFF_SKILL="${2:?missing value for $1}"; shift 2 ;;
    --pi-arg)
      PI_ARGS+=("${2:?missing value for $1}"); shift 2 ;;
    -h|--help)
      usage; exit 0 ;;
    *)
      echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

for cmd in gh jq jj pi; do
  command -v "$cmd" >/dev/null || { echo "Missing required command: $cmd" >&2; exit 1; }
done

if ! [[ "$LIMIT" =~ ^[0-9]+$ ]]; then
  echo "--limit must be a non-negative integer" >&2
  exit 2
fi

slugify() {
  tr '[:upper:]' '[:lower:]' |
    sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//' |
    cut -c1-48
}

ensure_jj_description() {
  local number="$1"
  local title="$2"
  local description
  description="$(jj log -r @ --no-graph --template 'description' 2>/dev/null | sed 's/[[:space:]]*$//' || true)"

  if [[ -z "$description" ]]; then
    jj describe -m "feat: ${title} (#${number})"
  fi
}

issue_is_unblocked() {
  local issue_json="$1"
  local open_blockers
  open_blockers="$(jq '[.blockedBy.nodes[]? | select(.state != "CLOSED")] | length' <<<"$issue_json")"
  [[ "$open_blockers" -eq 0 ]]
}

fetch_candidates() {
  local label="$1"
  gh issue list -R "$REPO" --state open --label "$label" --limit 1000 --json number --jq '.[].number' 2>/dev/null || true
}

mapfile -t issue_numbers < <({ fetch_candidates "$LABEL"; fetch_candidates "read-for-agent"; } | sort -n -u)

worked=0
original_rev="$(jj log -r @ --no-graph --template 'change_id' 2>/dev/null || true)"

for number in "${issue_numbers[@]}"; do
  issue_json="$(gh issue view "$number" -R "$REPO" --json number,title,body,url,labels,author,comments,blockedBy)"
  if ! issue_is_unblocked "$issue_json"; then
    blockers="$(jq -r '[.blockedBy.nodes[]? | select(.state != "CLOSED") | "#\(.number)"] | join(", ")' <<<"$issue_json")"
    echo "Skipping #$number: blocked by ${blockers:-unknown open blocker}"
    continue
  fi

  title="$(jq -r .title <<<"$issue_json")"
  branch="agent/issue-${number}-$(printf '%s' "$title" | slugify)"
  echo "Working #$number: $title"

  jj git fetch --remote origin
  jj new "$BASE_BRANCH@origin"

  prompt_file="$(mktemp)"
  review_handoff="$(mktemp -t "pi-bites-issue-${number}-review-XXXXXX.md")"
  jq -r --arg repo "$REPO" --arg base "$BASE_BRANCH" '
    "You are working in the GitHub repository \($repo).\n" +
    "Implement issue #\(.number): \(.title)\n\n" +
    "Issue URL: \(.url)\n\n" +
    "Labels: " + ([.labels[].name] | join(", ")) + "\n\n" +
    "Issue body:\n" + (.body // "") + "\n\n" +
    "Comments:\n" + ((.comments // []) | map("---\n@\(.author.login):\n\(.body)") | join("\n")) + "\n\n" +
    "Instructions:\n" +
    "- Treat this as an AFK ready-for-agent issue.\n" +
    "- Make the smallest complete change that satisfies the acceptance criteria.\n" +
    "- Use jj, not git, for VCS operations. Do not run git diff/status/commit.\n" +
    "- For diffs, compare against " + $base + "@origin with jj, for example `jj diff --from " + $base + "@origin`.\n" +
    "- Run relevant checks, including `bun check` before finishing.\n" +
    "- Describe the current jj change with a clear git conventional message mentioning #\(.number).\n" +
    "- Do not create a PR yet; a separate review/fix/PR pipeline will run next.\n" +
    "- If you cannot safely complete the issue, leave the worktree clean and explain why.\n"
  ' <<<"$issue_json" > "$prompt_file"

  pi "${PI_ARGS[@]}" --name "issue #$number implement" "$(cat "$prompt_file")"
  ensure_jj_description "$number" "$title"

  pi "${PI_ARGS[@]}" --name "issue #$number review" --skill "$REVIEW_SKILL" --skill "$HANDOFF_SKILL" "$(cat <<REVIEW_PROMPT
Review the current jj change for issue #$number using the thermo-nuclear-code-quality-review skill.

Original issue prompt is in: $prompt_file
Base branch/change is: $BASE_BRANCH@origin

Use jj commands only. Do not run git diff/status/commit. For the changed-code diff, use `jj diff --from $BASE_BRANCH@origin` or equivalent jj commands; do not assume the base branch is main.

Write the review results as a handoff document to exactly this path:
$review_handoff

The handoff must summarize high-conviction review findings, obvious/critical fixes to make, and suggested skills for the next agent. Do not modify code in this review session.
REVIEW_PROMPT
)"

  pi "${PI_ARGS[@]}" --name "issue #$number fix review" --skill "$HANDOFF_SKILL" "$(cat <<FIX_PROMPT
Implement the obvious or critical fixes/refactors from this review handoff:
$review_handoff

Original issue prompt is in: $prompt_file

Instructions:
- Use jj, not git, for VCS operations. Do not run git diff/status/commit. Squash any code changes into the original change.
- For diffs, compare against $BASE_BRANCH@origin with jj, for example `jj diff --from $BASE_BRANCH@origin`; do not assume the base branch is main.
- Preserve the behavior required by issue #$number.
- Run relevant checks, including bun check when appropriate.
- Update the review handoff in place, noting what was addressed and what was intentionally left unaddressed.
- Do not create a PR; a separate session will do that next.
FIX_PROMPT
)"
  ensure_jj_description "$number" "$title"

  pi "${PI_ARGS[@]}" --name "issue #$number create PR" "$(cat <<PR_PROMPT
Create the pull request for issue #$number.

Original issue prompt is in: $prompt_file
Review/fix handoff is in: $review_handoff
Branch/bookmark name to use: $branch
Base branch: $BASE_BRANCH
Repo: $REPO

Instructions:
- Read the original issue prompt and review handoff.
- Use jj, not git, for VCS operations. Do not run git diff/status/commit.
- For diffs, compare against $BASE_BRANCH@origin with jj, for example `jj diff --from $BASE_BRANCH@origin`; do not assume the base branch is main.
- Ensure the current jj change has a good description mentioning #$number.
- Create or update a jj bookmark named $branch pointing at the current change.
- Push it with jj to GitHub.
- Create the PR with gh pr create against $BASE_BRANCH.
- The PR body must include Closes #$number.
- The PR description should summarize the implementation, explain non-obvious code areas and critical code paths, and explicitly cover review comments that were not addressed by the fix agent.
- Keep the PR description extremely concise. Sacrifice grammar for the sake of concision.
PR_PROMPT
)"

  rm -f "$prompt_file"

  worked=$((worked + 1))
  if [[ "$LIMIT" -gt 0 && "$worked" -ge "$LIMIT" ]]; then
    break
  fi
done

if [[ -n "$original_rev" ]]; then
  jj edit "$original_rev" >/dev/null 2>&1 || true
fi

echo "Processed $worked issue(s)."
