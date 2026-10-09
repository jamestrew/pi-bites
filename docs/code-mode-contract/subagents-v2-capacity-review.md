# V2 nesting and capacity review

Source audit for #384/#385: inspected local `/home/jt/projects/codex` at
`cb6da58876afed3ede0ab11084f67dd5394ecb48` and the migration pin
`1a89aec960cd92e2c59ce49b7f3c3347a915e4a9` using local Git objects. The nesting
and capacity conclusions below hold at both revisions; links cite the pin.
No upstream runtime/provider tests were run.

- **Depth and capacity are independent.** V2 records increasing child depth but
  does not enforce `agent_max_depth`; only V1's availability branch checks it.
  Upstream V2 still gates child collaboration tools on model metadata.
  Sources: [availability](https://github.com/openai/codex/blob/1a89aec960cd92e2c59ce49b7f3c3347a915e4a9/codex-rs/core/src/tools/spec_plan.rs#L672-L682),
  [spawn](https://github.com/openai/codex/blob/1a89aec960cd92e2c59ce49b7f3c3347a915e4a9/codex-rs/core/src/tools/handlers/multi_agents_v2/spawn.rs#L131-L154).
- **Four means root plus three subagents, shared across descendants—not three
  new slots per parent.** V2 defaults to four total and subtracts one for root;
  children receive a cloned controller sharing `Arc` registry, execution, and
  residency state.
  Sources: [default](https://github.com/openai/codex/blob/1a89aec960cd92e2c59ce49b7f3c3347a915e4a9/codex-rs/core/src/config/mod.rs#L253-L254),
  [root subtraction](https://github.com/openai/codex/blob/1a89aec960cd92e2c59ce49b7f3c3347a915e4a9/codex-rs/core/src/config/mod.rs#L1606-L1618),
  [shared state](https://github.com/openai/codex/blob/1a89aec960cd92e2c59ce49b7f3c3347a915e4a9/codex-rs/core/src/agent/control/runtime.rs#L21-L39),
  [controller inheritance](https://github.com/openai/codex/blob/1a89aec960cd92e2c59ce49b7f3c3347a915e4a9/codex-rs/core/src/agent/control/spawn.rs#L738-L751).
- **Four is not a lifetime-agent quota.** Execution and residency are separate:
  completion drops the running-task guard, but terminal runtimes remain resident
  until eligible eviction. V2 registry reservations omit the lifetime count
  limit, so evicted identities may survive beyond the resident capacity.
  Sources: [spawn admission](https://github.com/openai/codex/blob/1a89aec960cd92e2c59ce49b7f3c3347a915e4a9/codex-rs/core/src/agent/control/spawn.rs#L648-L677),
  [completion](https://github.com/openai/codex/blob/1a89aec960cd92e2c59ce49b7f3c3347a915e4a9/codex-rs/core/src/tasks/mod.rs#L651-L658),
  [residency/eviction](https://github.com/openai/codex/blob/1a89aec960cd92e2c59ce49b7f3c3347a915e4a9/codex-rs/core/src/agent/control/residency.rs#L100-L212).
- **Execution admission is advisory, not atomic.** Capacity check and running
  count increment are separate. Do not characterize upstream as guaranteeing an
  exact four-thread ceiling under concurrent admission races. Pending residency
  slots do count; uncommitted residency and registry reservations release on drop.
  Sources: [execution limiter](https://github.com/openai/codex/blob/1a89aec960cd92e2c59ce49b7f3c3347a915e4a9/codex-rs/core/src/agent/control/execution.rs#L22-L85),
  [residency reservation](https://github.com/openai/codex/blob/1a89aec960cd92e2c59ce49b7f3c3347a915e4a9/codex-rs/core/src/agent/control/residency.rs#L34-L46),
  [registry rollback](https://github.com/openai/codex/blob/1a89aec960cd92e2c59ce49b7f3c3347a915e4a9/codex-rs/core/src/agent/registry.rs#L378-L393).

See [the full lifecycle audit](subagents-v2-upstream-lifecycle.md) for reload,
completion routing, eviction eligibility, and cancellation details.

## Original PR comparison (historical)

Reviewed pi-bites commit `74914cd57d85488cdcdcc348ca0615647db3befc` (#385).
Its runtime changes remove the implicit depth limit in
`packages/ext/subagents/agent-tree.ts:13-25,49-66` and reset absent depth settings
in `packages/ext/subagents/settings.ts:137`. Capacity implementation is unchanged:
`packages/ext/subagents/agent-manager.ts:30,182-192` still defaults to six child
execution slots, excluding root, and `agent-runtimes.ts:110-142` independently
bounds child residency using the same setting. Child controllers reuse the root
manager (`operations.ts:120-133`); descendants do not receive separate budgets.
Named turns release execution reservations on settlement (`agent-manager.ts:453-467`).

**Original verdict:** matches V2's uncapped nesting and shared-tree capacity structure,
not its capacity default or advisory execution admission. Six shared child slots,
strict local execution reservations, explicit depth overrides, and all-model tool
availability are deliberate existing local policies. This is the requested #384
scope, not an accidental capacity-parity claim.

Verification: 209 focused tests across 12 files passed, including default nesting,
canonical paths, immediate-parent completion, explicit depth limits/settings reset,
shared capacity/retry, tool ceilings, residency, and invalidated owners. `bun check`
passed (1,380 package tests and 48 script tests; four package tests skipped).
These are offline/canned-provider checks, not live provider verification.

## Capacity-parity follow-up

The subsequent user decision supersedes #384/#344's instruction to retain the old
capacity default and strict execution reservations. Current behavior defaults to
three child slots (four including root) and uses advisory execution checks, shared
across descendants. Existing `maxConcurrent` settings still count children; this
does not silently reinterpret saved values as total-thread counts.

Spawn checks execution before residency admission and does not recheck after
initialization. Idle follow-up checks before accepting input, not again at start;
running-target follow-up bypasses admission. Queue-only/internal reload reserves
residency only, and unloaded follow-up checks execution after reload.

Pi's native `agent_start`/`agent_settled` events count actual logical runs, once
across retries/compaction, without reserving execution during initialization.
Intermediate `agent_end` does not release a run. Completion, error, abort, and
teardown release counts; old runtime subscriptions cannot count a replacement.
Native settlement and teardown own release; an older manager completion cannot
clear a newer native run. Native active execution also prevents residency eviction,
even when an older manager generation has completed.
Pi settlement timing remains a platform adaptation, not a claim to reproduce
Codex's exact task-hook timing. Resident admission still counts pending claims
and protects active/unsettled work and pending mail.

Regression evidence includes default root-plus-three direct spawns and an accepted
follow-up/start race through real Pi sessions with a canned provider. A native
settlement/microtask continuation regression protects the newer run's count and
residency while the previous prompt unwinds. Existing
residency, lifecycle, invalidation and nested-tool restriction checks remain in
place. Closed recovery also publishes its loaded record before releasing the
residency claim or notifying runtime-loaded observers; reentrant spawn cannot
claim an uncounted extra slot. No live provider or upstream Rust tests were run.
