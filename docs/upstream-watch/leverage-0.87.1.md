# 0.87.1 Leverage follow-up (Ref #325)

This records implementation/verification of section 2, not acceptance of the
upstream review. `state.json` is unchanged.

## Auxiliary model calls

Automode review and session-tracker classification now call the session model
registry's `streamSimple(...).result()`. The registry resolves the configured
provider and request-time credentials, including headers (and deletion markers),
environment, and credential-specific base URL. Both calls retain their reasoning,
output limit, timeout, and error checks. Classification now also passes the
owning context's cancellation signal. All context dependencies are read before
awaiting; throwing-getter regressions guard against stale context access.

The real-registry classifier test uses an in-memory native provider and rotates
credentials between requests. It verifies base URL, header deletion markers,
environment, reasoning and limits reach the provider. It does not exercise a
remote service or `models.json` parsing.

## Why absolute compaction remains

Pi 0.87.1's native preparation hook checks projected usage after tool results,
before the next response. Per-model `compaction.modelOverrides` can set
`reserveTokens` and `keepRecentTokens`, but these are not an independent absolute
trigger:

- Native `shouldCompact` uses `tokens > contextWindow - reserveTokens`; Bites
  uses `tokens >= thresholdTokens` (default 150,000), irrespective of model.
- Mapping that trigger requires a different reserve for every context window,
  including model switches/custom models. Exact provider/id overrides fall back
  to global settings for unspecified fields; they do not express this rule.
- Reserve also controls summary output: normal summaries use 80% of reserve,
  capped by model output capacity; split-turn prefixes use 50%. Changing reserve
  to emulate an absolute trigger therefore changes the compaction budget.
- Native checks apply before prompts, between turns, and in post-run recovery.
  Bites deliberately skips parent print/JSON-mode automatic compaction and uses
  a separate turn-boundary path for subagents. A settings substitution would
  change those boundaries as well.

Retain `_runAutoCompaction` for subagent boundaries and the parent's abort / compact /
resume path. Existing regressions cover exact threshold equality, mode exclusions,
compaction failure/retry, external cancellation (including older-runtime auth
races), and stale callback contexts. The goal runtime's `session_compact_failed`
handler is unchanged. Replace these paths when upstream exposes an independent
absolute trigger and equivalent lifecycle/mode behavior, not merely a reserve.

Source anchors in installed `@earendil-works/pi-coding-agent/dist/core/`:
`compaction/compaction.js` (`shouldCompact`, summary budgets),
`settings-manager.js` (model overrides), and `agent-session.js`
(turn preparation, `_runAutoCompaction`, `compact`). In 0.87.1 the
compaction abort controller is created before authentication; the compatibility
watcher remains for older runtimes allowed by the package's peer range.

## Metadata and terminating denials

Real SDK session tests exercise sequential and parallel tool batches:

- The actual at-mention input handler runs while tools are paused, via
  `extensionRunner.emitInput` (which does not enqueue a user prompt).
- The subagent messenger's explicit non-steering flush uses `triggerTurn:false`.
  Neither message appears between the assistant call and either tool result;
  both appear on the next natural model request.
- With every tool denied with `terminate:true`, non-steering metadata is persisted
  after both results without causing another model request. With an allowed or
  non-terminating-denied sibling, the run continues normally. Denied tools do not
  execute; authorization records retain the correct statuses.

No delivery workaround was removed. The messenger's active-turn steering,
post-terminal deferral, shutdown persistence, and intermediate-before-final FIFO
rules are intentional semantics, not equivalents of non-steering metadata.

## Verification scope

- Mocked regressions: automode review, classifier options/errors/stale context,
  existing absolute compaction and goal lifecycle coverage.
- Real 0.87.1 SDK with deterministic fake providers/tools: classifier credential
  resolution; active-batch metadata and all-terminating/mixed denial behavior.
- No authenticated remote-provider or interactive TUI smoke check was performed.

Run `bun check` for full validation, or the focused files:
`packages/ext/automode/index.test.ts`,
`packages/ext/session-tracker/model-call.test.ts`,
`packages/ext/auto-compaction.test.ts`, and
`packages/ext/subagents/test/subagent-messages-e2e.test.ts`.
