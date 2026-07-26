---
name: pi-upstream-watch
description: Pi upstream watch reviews pi changelog entries since the stored checkpoint, cross-checks this extension repo for leverage, deprecations, and adaptation tasks, then advances the checkpoint only when the user asks.
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

The checkpoint lives at `docs/upstream-watch/state.json`. It records the last reviewed pi version. Do not advance it until the user explicitly says the review is accepted or asks you to mark the version reviewed.

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

### 4. Advance the checkpoint only on request

If the user asks to mark the review complete, update `docs/upstream-watch/state.json` so `lastCheckedVersion` equals the latest upstream version, set `lastCheckedAt` to today, and optionally append the reviewed report path.

Completion criterion: the checkpoint matches the accepted upstream version, or remains unchanged if the user did not ask to advance it.
