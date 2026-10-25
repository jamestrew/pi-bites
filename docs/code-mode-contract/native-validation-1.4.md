# Pi 1.4 native runtime validation (#401)

## Scope and environment

Validation on 2026-10-25 UTC, Linux x86_64, Node 24.21.0 and Bun 1.4.2.
The development graph already pins `pi-coding-agent` and `pi-tui` to **1.4.0**
(commit `dc1c1905`); `bun.lock` and the installed `pi-ai`, `pi-agent-core`,
`pi-codemode`, `pi-mcp` and `pi-telemetry` also resolve to **1.4.0**. No dependency
churn, release bump, minimum-host increase or upstream-watch checkpoint change is
needed. Wildcard peer declarations remain unchanged.

This record supplements, rather than replaces, the historical
[0.99.1 validation](native-validation.md). Pi owns workers, summaries and dialogs;
the [native adapter contract](native-parent.md), SDK capability ceilings and
per-launch bash authorization remain unchanged. Evidence is offline and synthetic;
no live provider requests or credential inspection are part of this run.

## Distribution probes

Both executable versions report **1.4.0**. PATH `pi` selects the npm installation,
so it is not evidence for the compiled distribution. The explicit system path
selects the Nix-packaged compiled CLI; the local `.bin` path selects the npm CLI.

```sh
/run/current-system/sw/bin/pi -v
pi -v
bun scripts/native-codemode-cli-smoke.ts /run/current-system/sw/bin/pi
bun scripts/native-codemode-cli-smoke.ts node_modules/.bin/pi
```

Both probes **pass**: their enclosing native codemode tool result is successful
and contains `Output: 42`. They use the existing isolated offline provider probe,
not just extension registration or process exit. The historical compiled-worker
packaging failure does **not** reproduce with this installed 1.4.0 system package.
These probes load native codemode, not the full pi-bites package; registered adapter
integration is established separately below.

## Automated integration evidence

- `agent-capabilities-e2e.test.ts` adds a real embedded-child/registered-parent
  contention regression. Two parent scripts hold the default two native workers
  with deferred harmless approvals, not CPU loops. A queued child abort and a
  queued deadline both report that the script did not start; neither reaches
  command approval. Releasing one parent admits a subsequent child script while
  the other parent remains blocked. Cancelled/expired marker files never appear,
  and a later script returns 42. All scripts have deadlines and cleanup aborts
  owned invocations. Agent execution admission is not changed.
- `subagent-messages-e2e.test.ts` adds an actual split-turn summary request through
  a synthetic provider. With `reserveTokens: 7` and model output allowance 100,
  the request carries no fixed `maxTokens` cap. Custom focus instructions survive
  the split-only prefix summary, thinking blocks are omitted, a checkpoint is
  persisted, and the next prompt consumes it.
- The same real-session fixture binds TUI extension mode (without pretending to
  create a terminal UI) and drives automatic compaction at the configured
  threshold. The tool turn settles aborted, a native summary persists, and exactly
  one custom continuation consumes it and settles successfully.
- Existing `auto-compaction.test.ts` covers configured thresholds, context-window
  caps, continuation, cancellation during auth/summary, and throwing stale
  contexts. `subagents-print-mode-e2e.test.ts` exercises the production child's
  guarded turn-boundary compaction seam and verifies the invocation completes
  after one summary without an aborted assistant result.
- The full check includes native discovery/accounting, permissions, shell lifetime,
  explicit cancellation ownership, late approvals, images/errors/full-output
  paths, saved timing, settlement/capacity, tracker and diagnostics regressions.
  Focused timing/settlement work remains owned by #405–#406; passing existing
  coverage here does not close those issues or claim their entire matrix.

Reproducible focused checks (repository root):

```sh
bunx vitest run packages/ext/subagents/test/agent-capabilities-e2e.test.ts packages/ext/subagents/test/subagent-messages-e2e.test.ts packages/ext/subagents/test/subagents-print-mode-e2e.test.ts
bun --bun vitest run packages/ext/subagents/test/agent-capabilities-e2e.test.ts packages/ext/codex-adapter/native-registration.test.ts -t 'shares worker|native timeout'
bun run typecheck
bun check
```

The Bun-specific run separately exercises queued cancellation/deadlines and the
existing busy-script timeout/reuse regression. Node coverage alone is not relabeled
Bun coverage. The full check runs package tests under Node and script tests under
Bun: **95 package files / 1,440 tests pass (4 opt-in live tests skipped)** and
**4 script files / 49 tests pass**. The focused three-file run passes 37 tests
(the same four live tests skipped); the Bun-specific two-test run passes.

## Selected tools across resume and tree navigation (#403)

The focused compatibility run uses the same Linux x64 environment and **Pi 1.4.0**
development graph, npm CLI and compiled system CLI described above. The checkout
already includes branch-local adapter permission checkpoints. No production
reconciliation change or dependency update is necessary: the observable restoration
matrix passes against the actual 1.4 host, not a simulated restoration algorithm.
Pi restores saved declarations; the adapter checkpoints retain the underlying core
selection that its projection displaces. Saved display still cannot restore resources.

`selection-persistence.test.ts` drives persisted `SessionManager.open` sessions and
public `AgentSession.navigateTree` calls. Coverage includes ordinary tool additions
and removals; fresh ordinary tools absent from an old branch; never-mentioned
`defaultActive:false` tools; newly registered owned image tools remaining hidden;
codemode disable/re-enable across resume and both branch directions; startup
`+codemode`/`-codemode`; replacement registry/default selections, exclusions and
no-builtin restrictions; shell/patch execution; and read-only model transitions
restoring only displaced cores. Existing registered-session tests retain branch
shell/store invalidation, late-approval and throwing-stale-context checks.

The existing SDK-child ceiling cases now recover **full-access history into a
narrower current registry** before checking native discovery, model-facing tool
search, refused execution, model switches and reload. Persisted selection cannot
recover forbidden patch, web or image tools, or shell in the read-only child.

The offline CLI probe launches the selected executable twice with an isolated
synthetic provider and temporary session files. It executes native codemode and
asserts `Output: 42`, persists a codemode disable, reopens that session, navigates
to the enabled branch, executes codemode successfully there, then navigates back
to the disabled branch. Both compiled and npm **1.4.0** probes pass. This checks
real RPC extension-command navigation, not terminal `/tree` UI acceptance.
The probe loads the shared adapter, not every pi-bites extension.

```sh
bunx vitest run packages/ext/codex-adapter/native-registration.test.ts packages/ext/codex-adapter/selection-persistence.test.ts packages/ext/subagents/test/agent-capabilities-e2e.test.ts
bun --bun vitest run packages/ext/codex-adapter/selection-persistence.test.ts
bun scripts/tool-selection-cli-smoke.ts /run/current-system/sw/bin/pi
bun scripts/tool-selection-cli-smoke.ts node_modules/.bin/pi
bun scripts/native-codemode-cli-smoke.ts /run/current-system/sw/bin/pi
bun run typecheck
bun check
```

The focused run passes **59 tests**; the separate Bun restoration run passes **17**.
The final `bun check` passes **95 package files / 1,446 tests** (4 opt-in live tests
skipped) and **4 script files / 49 tests**. An initial full run encounters an EPIPE
in the existing nested-web rendering helper; its focused rerun and the subsequent
full check pass without changes to that fixture. No selection regression fails.
No provider network, user credentials, live MCP server, interactive terminal,
other architecture or older Pi version is part of this evidence. Upstream-watch
state is unchanged.

## Unexecuted acceptance and limits

- **Interactive fullscreen and regular-mode overlap: not run.** This agent run
  does not provide human terminal acceptance, and the repository has no terminal
  dialog automation fixture. Fake UI approvals above do not establish stacking,
  overlay ownership, transcript scrolling or pixel-image display. In each mode,
  open a harmless gated approval, overlap a custom viewer/selector, close in both
  orders, repeat with cancellation, then verify both promises settle and the
  earlier UI and transcript scrolling still work. This remains a manual release
  validation gap, not an observed 1.4 failure or permission to add a local dialog
  manager.
- **Live routes/long-reasoning summaries: not run.** No credential availability is
  assumed and no provider fallback is selected. Existing route probes remain the
  entrypoints for a separately authorized live exercise. Synthetic summary
  requests establish integration, not a long-reasoning provider's reliability.
- **Other environments: not run.** No arm64, other OS, Bun 1.3.11, additional
  compiled packaging variant or minimum-host compatibility claim follows from
  this Linux x64 / Pi 1.4.0 evidence.
- Standalone/nested web padding and shared custom-start prompt composition retain
  their separate #402/#404 acceptance scopes. No unrelated renderer or prompt
  rewrite is included here.

This evidence does not accept the upstream review or declare all distributions,
interactive behavior and provider routes release-ready.
