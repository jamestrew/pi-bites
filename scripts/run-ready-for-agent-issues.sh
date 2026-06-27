#!/usr/bin/env bash
set -euo pipefail

REPO="jamestrew/pi-bites"
LIMIT=0
JOBS=1
LABEL="ready-for-agent"
BASE_BRANCH="master"
REVIEW_SKILL="/home/jt/.agents/skills/thermonuclear-review/SKILL.md"
HANDOFF_SKILL="/home/jt/.agents/skills/handoff/SKILL.md"
PI_ARGS=(--print --approve --yolo)

usage() {
  cat <<USAGE
Usage: $0 [--limit N] [--jobs N] [--repo OWNER/REPO] [--label LABEL] [--base BRANCH] [--review-skill PATH] [--handoff-skill PATH] [--pi-arg ARG ...]

Find open ready-for-agent issues for this repo that are not blocked by any open
native GitHub blocking relationship and do not already have an open linked PR,
then run a non-interactive pi implementation/review/fix/PR pipeline for each issue.

Options:
  -n, --limit N        Maximum number of issues to work on (default: no cap)
  -j, --jobs N         Number of issues to run in parallel (default: $JOBS)
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
    -j|--jobs)
      JOBS="${2:?missing value for $1}"; shift 2 ;;
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

if ! [[ "$JOBS" =~ ^[1-9][0-9]*$ ]]; then
  echo "--jobs must be a positive integer" >&2
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
  open_blockers="$(jq '[((.blockedBy | if type == "object" then (.nodes // []) elif type == "array" then . else [] end)[]) | select(.state != "CLOSED")] | length' <<<"$issue_json")"
  [[ "$open_blockers" -eq 0 ]]
}

issue_has_open_pr() {
  local issue_json="$1"
  local open_prs
  open_prs="$(jq '[((.closedByPullRequestsReferences | if type == "object" then (.nodes // []) elif type == "array" then . else [] end)[]) | select(.state == "OPEN")] | length' <<<"$issue_json")"
  [[ "$open_prs" -gt 0 ]]
}

fetch_candidates() {
  local label="$1"
  gh issue list -R "$REPO" --state open --label "$label" --limit 1000 --json number --jq '.[].number' 2>/dev/null || true
}

mapfile -t issue_numbers < <({ fetch_candidates "$LABEL"; fetch_candidates "read-for-agent"; } | sort -n -u)

selected_issue_files=()
for number in "${issue_numbers[@]}"; do
  issue_json="$(gh issue view "$number" -R "$REPO" --json number,title,body,url,labels,author,comments,blockedBy,closedByPullRequestsReferences)"
  if ! issue_is_unblocked "$issue_json"; then
    blockers="$(jq -r '[((.blockedBy | if type == "object" then (.nodes // []) elif type == "array" then . else [] end)[]) | select(.state != "CLOSED") | "#\(.number)"] | join(", ")' <<<"$issue_json")"
    echo "Skipping #$number: blocked by ${blockers:-unknown open blocker}"
    continue
  fi

  if issue_has_open_pr "$issue_json"; then
    prs="$(jq -r '[((.closedByPullRequestsReferences | if type == "object" then (.nodes // []) elif type == "array" then . else [] end)[]) | select(.state == "OPEN") | "#\(.number)"] | join(", ")' <<<"$issue_json")"
    echo "Skipping #$number: already has open PR ${prs:-unknown}"
    continue
  fi

  issue_file="$(mktemp -t "pi-bites-issue-${number}-XXXXXX.json")"
  printf '%s\n' "$issue_json" > "$issue_file"
  selected_issue_files+=("$issue_file")

  if [[ "$LIMIT" -gt 0 && "${#selected_issue_files[@]}" -ge "$LIMIT" ]]; then
    break
  fi
done

process_issue() {
  local issue_file="$1"
  local issue_json number title branch prompt_file review_handoff workdir workspace_name
  issue_json="$(cat "$issue_file")"
  number="$(jq -r .number <<<"$issue_json")"
  title="$(jq -r .title <<<"$issue_json")"
  branch="agent/issue-${number}-$(printf '%s' "$title" | slugify)"
  echo "Working #$number: $title"

  workdir=""
  workspace_name=""
  if [[ "$JOBS" -gt 1 ]]; then
    workdir="$(mktemp -d -t "pi-bites-issue-${number}-workspace-XXXXXX")"
    workspace_name="issue-${number}-$$"
    jj workspace add --name "$workspace_name" --revision "$BASE_BRANCH@origin" "$workdir"
    cd "$workdir"
  else
    jj new "$BASE_BRANCH@origin"
  fi

  prompt_file="$(mktemp)"
  review_handoff="$(mktemp -t "pi-bites-issue-${number}-review-XXXXXX.md")"
  trap 'rm -f "$prompt_file" "$issue_file"; if [[ -n "${workdir:-}" ]]; then jj workspace forget "${workspace_name:-}" >/dev/null 2>&1 || true; rm -rf "$workdir"; fi' RETURN

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
    "- This may be a jj workspace without .git metadata; gh cannot infer the repo. Pass `-R " + $repo + "` to every gh command.\n" +
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

Use jj commands only. Do not run git diff/status/commit. For the changed-code diff, use 'jj diff --from $BASE_BRANCH@origin' or equivalent jj commands; do not assume the base branch is main.

This may be a jj workspace without .git metadata; gh cannot infer the repo. Pass '-R $REPO' to every gh command.

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
- This may be a jj workspace without .git metadata; gh cannot infer the repo. Pass '-R $REPO' to every gh command.
- For diffs, compare against $BASE_BRANCH@origin with jj, for example 'jj diff --from $BASE_BRANCH@origin'; do not assume the base branch is main.
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
- This may be a jj workspace without .git metadata; gh cannot infer the repo. Pass '-R $REPO' to every gh command.
- For diffs, compare against $BASE_BRANCH@origin with jj, for example 'jj diff --from $BASE_BRANCH@origin'; do not assume the base branch is main.
- Ensure the current jj change has a good description mentioning #$number.
- Create or update a jj bookmark named $branch pointing at the current change.
- Push it with jj to GitHub.
- Create the PR non-interactively with 'gh pr create -R $REPO -B $BASE_BRANCH -H $branch --title ... --body ...' or '--body-file ...'.
- Request PR review from the authenticated GitHub user by passing '-r @me' to gh pr create.
- Do not rely on gh prompts or repo inference.
- The PR body must include Closes #$number.
- The PR description should summarize the implementation, explain non-obvious code areas and critical code paths, and explicitly cover review comments that were not addressed by the fix agent.
- The PR description must highlight the changeset seams: the critical interfaces/places where behavior changed or can be altered, and what the maintainer should understand or pay attention to when reviewing them.
- Keep the PR description extremely concise. Sacrifice grammar for the sake of concision.
- After creating the PR, inspect the review/fix handoff. If it shows 0 remaining review issues / no intentionally unaddressed review findings, merge the PR non-interactively with gh. If any review issue remains, leave the PR open for human review.
PR_PROMPT
)"
}

original_rev="$(jj log -r @ --no-graph --template 'change_id' 2>/dev/null || true)"
jj git fetch --remote origin

running=0
failures=0
for issue_file in "${selected_issue_files[@]}"; do
  process_issue "$issue_file" &
  running=$((running + 1))
  if [[ "$running" -ge "$JOBS" ]]; then
    if ! wait -n; then
      failures=$((failures + 1))
    fi
    running=$((running - 1))
  fi
done

while [[ "$running" -gt 0 ]]; do
  if ! wait -n; then
    failures=$((failures + 1))
  fi
  running=$((running - 1))
done

if [[ -n "$original_rev" ]]; then
  jj edit "$original_rev" >/dev/null 2>&1 || true
fi

worked="${#selected_issue_files[@]}"
echo "Processed $worked issue(s) with $failures failure(s)."
if [[ "$failures" -gt 0 ]]; then
  exit 1
fi
