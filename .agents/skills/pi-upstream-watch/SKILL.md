---
name: pi-upstream-watch
description: Review pi changelog entries since the stored checkpoint, cross-check this repo for adaptation and leverage, and ask the user to accept the review before advancing the checkpoint.
disable-model-invocation: true
---

# Pi Upstream Watch

Review upstream pi changes against this extension collection.

## Bundled script

Use the bundled helper at `scripts/check-pi-upstream.ts` for deterministic changelog fetching. From this repo, run:

```bash
bun .agents/skills/pi-upstream-watch/scripts/check-pi-upstream.ts
```

The helper writes `docs/upstream-watch/latest.md` and reads/writes `docs/upstream-watch/state.json`.

## Checkpoint

The checkpoint lives at `docs/upstream-watch/state.json`. It records the last accepted review, not the installed version or verified upgrade compatibility. Acceptance is handled in step 4.

## Process

### 1. Fetch the delta

Run the bundled helper. Read `docs/upstream-watch/latest.md` and `docs/upstream-watch/state.json`.

Completion criterion: you know the checkpoint version, latest upstream version, and every changelog entry between them.

### 2. Map the blast radius

Search this repo for uses of pi surfaces named or implied by the changelog: extension lifecycle, hooks, tools, TUI, config, commands, providers, models, sessions, settings, prompt templates, docs paths, package names, and CLI behavior.

Completion criterion: every changelog item is classified as one of: `adapt`, `leverage`, `watch`, or `irrelevant`, with the local files or absence of local usage noted.

### 3. Produce the review

Report four sections:

- **Adapt** — required changes, deprecations, behavior shifts, broken assumptions.
- **Leverage** — new APIs or fixes this repo can simplify around.
- **Watch** — upstream changes worth remembering but not acting on yet.
- **Ignore** — entries with no plausible impact.

For each non-ignore item, include the upstream version, changelog quote or summary, local evidence, and recommended next action.

Completion criterion: the user has an actionable review with no uncategorized changelog entries.

### 4. Close the review with an acceptance question

After presenting the review, ask: "Mark Pi <reviewed version> reviewed and advance the checkpoint from <checkpoint version>?" The agent owns this reminder so the user does not need to remember the state file. If the user first asks questions or requests follow-up issues, answer or complete those, then return to this question when no review questions remain.

On explicit acceptance or a direct request to mark the version reviewed, update `lastCheckedVersion` to the reviewed version, set `lastCheckedAt` to today's UTC date, and append the saved review report path without duplicates. Use the version actually reviewed, even if a newer release is now available. Review acceptance can precede implementation of its follow-up issues; it does not certify upgrade compatibility.

While approval is pending or declined, leave the checkpoint unchanged. Creating issues alone is not approval.

Completion criterion: the checkpoint matches the accepted reviewed version, or the user has been asked to accept it and the unchanged checkpoint is explicitly reported as awaiting approval or left unchanged at the user's request.
