# Upstream V2 lifecycle, capacity, and addressing

## Source pin and scope

Inspected `/home/jt/projects/codex` (`../codex`) at Git HEAD **`1a89aec960cd92e2c59ce49b7f3c3347a915e4a9`**. Its working tree was clean. All source citations below are paths relative to that checkout, with inclusive line ranges. This is a source audit, not a runtime test result. No upstream code was changed.

Scope: model tools through local agent control, addressing, visibility, execution/residency limits, reload, interruption, descendants, and cancellation. Mailbox delivery details and Pi implementation are covered separately. The product decision for pi-bites is **V2-only direct tools for all models, without `tool_search`**; upstream model gating described below is an observation, not a change to that decision.

## Model surface versus controller surface

- The V2 registration branch installs `spawn_agent`, `interrupt_agent`, and `list_agents`; `send_message`/`followup_task` depend on `disable_direct_message`, and `wait_agent` depends on `wait_agent_enabled`. Exposure is `Direct` or `DirectModelOnly`, not search-deferred. Namespace wrapping depends on provider namespace support and configured namespace. V1's search-dependent `Deferred` branch is separate. Sources: `codex-rs/core/src/tools/spec_plan.rs:1299-1403`.
- Upstream V2 collaboration availability is not identical for every model: a session without an agent path passes the V2 gate; a session with an agent path requires model metadata `multi_agent_version == V2`. V1 alone checks configured spawn depth here. Source: `codex-rs/core/src/tools/spec_plan.rs:672-682`.
- V2 has no model-facing `close_agent` or `resume_agent` registration. Follow-up handles reload internally. The controller also exposes internal `ensure_child_loaded`, `child_agent_paths`, admission checks/guards, and completion reporting; these are not extra model tools. Sources: `codex-rs/core/src/tools/spec_plan.rs:1302-1395`; `codex-rs/core/src/agent/api.rs:40-122`.

## Spawn names and target addressing

- `spawn_agent` requires string `message` and `task_name`; unknown fields are rejected. The handler prepares V2 child configuration, computes child depth, and calls `thread_spawn_source`, which **joins one task-name segment onto the caller's canonical path** (default `/root`). The controller receives a `SpawnRequest` with caller identity, that source, trigger-turn input, and parent metadata. Sources: `codex-rs/core/src/tools/handlers/multi_agents_v2/spawn.rs:121-159,184-207,261-270`; `codex-rs/core/src/tools/handlers/multi_agents_common.rs:133-156`.
- Valid name characters are ASCII lowercase letters, digits, and `_`; empty names, `root`, `.`, `..`, and `/` are rejected. There is no leading-letter restriction in this validator. Absolute paths must be rooted at `/root`, except the special exact `/morpheus` path; trailing slashes and invalid segments fail. Relative target paths can contain multiple validated segments and are appended to the current path; `..` navigation is not supported. Sources: `codex-rs/protocol/src/agent_path.rs:54-71,125-180`.
- Canonical paths are reserved under a registry mutex; an already occupied path fails with `agent path ... already exists`. Reservation becomes registered identity at commit; dropping an uncommitted reservation releases its path and count. Thus identical task names under different parents have different keys. Sources: `codex-rs/core/src/agent/registry.rs:297-327,372-393`.
- Model target resolution calls `AgentControl::resolve`. It accepts a parseable thread ID first, otherwise resolves a path relative to the caller's captured session source and looks up that path in the shared registry. A valid ID is not, by itself, proof of permission or membership. Sources: `codex-rs/core/src/agent/agent_resolver.rs:8-29`; `codex-rs/core/src/agent/control/api.rs:40-55`; `codex-rs/core/src/agent/control/target.rs:33-59`.
- For V2 message/follow-up operations, controller dispatch requires **both receiver and author to be known in this controller's registry**. Follow-up rejects root; it does not require that the caller be the target's immediate parent, and does not reject self. V2 interrupt requires a known target and rejects root and self, but likewise has no immediate-parent-only check. These are tree-registry checks, not global manager-wide thread-ID authorization. Sources: `codex-rs/core/src/agent/control/api.rs:120-157`; `codex-rs/core/src/agent/control/runtime_context.rs:25-28`; `codex-rs/core/src/agent/control/interrupt.rs:16-50`.
- The controller's legacy `AgentInput::UserInput` branch can address loaded threads outside the agent registry; V2 model messaging uses `AgentInput::Message`, not that branch. Sources: `codex-rs/core/src/agent/control/api.rs:110-157`; `codex-rs/core/src/tools/handlers/multi_agents_v2/message_tool.rs:57-81`.
- Spawn response exposes canonical `task_name`, optionally `nickname`, not the controller's internal thread/config snapshot. Sources: `codex-rs/core/src/tools/handlers/multi_agents_v2/spawn.rs:241-252,310-319`.

## List visibility is not durable membership

- `list_agents` passes caller identity/source and optional `path_prefix` into controller `list`, and returns only `{agents: [{agent_name, agent_status}]}`. Names are canonical paths, with an internal ID fallback. Source: `codex-rs/core/src/tools/handlers/multi_agents_v2/list_agents.rs:41-67,77-91`.
- Without a prefix, it considers the **whole shared registry**, not only the caller's children. It prepends the loaded root and sorts registered agents by canonical path (then ID). Each non-root entry must still have a loaded thread; unloaded entries are silently skipped. Sources: `codex-rs/core/src/agent/control.rs:348-418`; `codex-rs/core/src/agent/control/api.rs:196-206`.
- Prefix resolution is relative to the caller's path unless absolute. Matching is exact path or slash-delimited descendant, not arbitrary string prefix. `/root` is a match-all special case. Sources: `codex-rs/core/src/agent/control.rs:354-362,654-665`.
- Internal `child_agent_paths` differs: it includes known **direct** children even when unloaded, sorting loaded children first and alphabetically within groups. It is a context API, not `list_agents`. Source: `codex-rs/core/src/agent/control/api.rs:209-243`.

## Execution capacity and resident capacity are separate

| State/resource      | What upstream counts or retains                                                                                                           |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Registered identity | Canonical path and metadata survive normal V2 residency eviction.                                                                         |
| Execution slot      | A V2 subagent's running task owns a guard; dropping it decrements active count. Root and non-V2 turns do not own this guard.              |
| Resident slot       | A loaded V2 subagent runtime counts, including an idle completed/interrupted/errored runtime; reservations also count before publication. |

Sources: `codex-rs/core/src/agent/control/execution.rs:22-29,51-85`; `codex-rs/core/src/agent/control/residency.rs:124-133,198-206,234-249,257-271`.

- V2 configured `max_concurrent_threads_per_session` includes root: effective subagent capacity is `saturating_sub(1)`. Default is **4 total / 3 subagents**. Legacy `agents.max_concurrent_threads_per_session`, when used as fallback, is translated by adding one. Zero V2 total is rejected; one permits no subagent slots. Sources: `codex-rs/core/src/config/mod.rs:253-254,1606-1618,2751-2762,3828-3833`.
- V2 spawn first performs an execution-capacity check, then reserves a resident slot, then reserves registry metadata **without** the registry's lifetime thread limit. Therefore retained completed identities do not exhaust a total-ever-spawned V2 quota. Source: `codex-rs/core/src/agent/control/spawn.rs:630-677`.
- Execution admission is explicitly advisory: the capacity check and increment are separate, not an atomic semaphore reservation. A guard is acquired when registering a running task, and normal completion removes/drops that task before the later completion-processing work. Sources: `codex-rs/core/src/agent/api.rs:94-108`; `codex-rs/core/src/agent/control/execution.rs:33-76`; `codex-rs/core/src/tasks/mod.rs:332-338,407-418,651-658`.
- Normal completion is **not immediate runtime unload or identity deletion**. It releases the running-task guard; the completed runtime remains resident until eviction or another shutdown path. V2 does not start the legacy completion watcher after spawn. Sources: `codex-rs/core/src/tasks/mod.rs:651-658`; `codex-rs/core/src/agent/control/spawn.rs:858-879`; `codex-rs/core/src/agent/control/residency.rs:100-120,266-272`.
- At residency pressure, reservation scans oldest-touch-first candidates. A candidate must be V2/subagent, not protected, have an obtainable exclusive residency gate, be `Completed`, `Errored`, or `Interrupted`, have no active turn, and have no pending mailbox items. A generic idle/initializing runtime is not sufficient. No eligible candidate means `AgentLimitReached`, not waiting for one to finish. Sources: `codex-rs/core/src/agent/control/residency.rs:100-120,136-176,252-272`.
- Eviction materializes history, shuts down and waits, saves environment selections, then removes the manager runtime and residency entry. It does **not** release the registry identity or close the persisted spawn edge in this path. Shutdown failure leaves the slot occupied. Sources: `codex-rs/core/src/agent/control/residency.rs:177-212`; contrast explicit shutdown in `codex-rs/core/src/agent/control/legacy.rs:9-44`.

## Follow-up reload ordering and authority

1. Handler validates nonempty message, resolves target, builds resume config, and calls controller `send` with `TriggerTurn`.
2. Controller verifies registry identities and rejects root follow-up.
3. It calls `ensure_v2_agent_loaded` **before** communication submission and execution-capacity checking.
4. Trigger-turn submission checks execution capacity, except an already active target bypasses that check.

Sources: `codex-rs/core/src/tools/handlers/multi_agents_v2/followup_task.rs:39-49`; `codex-rs/core/src/tools/handlers/multi_agents_v2/message_tool.rs:32-38,57-81`; `codex-rs/core/src/agent/control/api.rs:120-156`; `codex-rs/core/src/agent/control.rs:158-179`; `codex-rs/core/src/codex_thread.rs:1121-1132`.

Consequences grounded in that order:

- Follow-up to a known unloaded agent can reload its runtime (and evict another eligible resident) before failing execution admission. A failed follow-up is not a promise that no runtime state changed.
- Reload is not exclusive to follow-up: queue-only model message dispatch also calls the same load helper before delivery. It does not thereby become trigger-turn input.
- Known identity is required before reading stored history. A loaded sender-driven target is touched and returned immediately. Otherwise storage is read including archived history, resumed history must be V2, stored model/provider/reasoning are restored, and a resident slot is reserved before publication. Sources: `codex-rs/core/src/agent/control/spawn.rs:338-374,410-462,585-627`.
- Model send uses `parent: None` (sender-driven reload). Internal `ensure_child_loaded(parent, child)` uses `Some(parent)` and additionally requires the exact live registered parent, same registry, V2 ownership, and matching recorded parent identity. It rebuilds runtime config from the parent's current settings and checks execution/environment authority. These stronger owner-attachment checks are not a parent-only restriction on model follow-up targets. Sources: `codex-rs/core/src/agent/control/api.rs:139-140,168-173`; `codex-rs/core/src/agent/control/spawn.rs:290-337,378-445,463-545`.
- Root resume restores metadata for persisted open descendants without reopening their runtimes; V2's resume path returns before the legacy recursive descendant-resume loop. Sources: `codex-rs/core/src/agent/control/spawn.rs:186-269,1244-1266`.

## Interrupt and descendants

- `interrupt_agent` resolves the target, calls V2 controller interrupt, and returns **previous_status**, not a post-interruption status or completion acknowledgment. The controller snapshots before submitting `Op::Interrupt`. Known unloaded/dead targets succeed without reload; an unloaded snapshot yields `NotFound` in the tool result. Sources: `codex-rs/core/src/tools/handlers/multi_agents_v2/interrupt_agent.rs:44-74`; `codex-rs/core/src/agent/control/interrupt.rs:16-50`; `codex-rs/core/src/agent/control/inspection.rs:12-29`; `codex-rs/core/src/agent/control.rs:297-312`.
- Root/self are rejected. A sibling or non-root ancestor is not rejected merely for its relationship to the caller. The operation dispatches only to the selected thread; session `interrupt_task` aborts that session's tasks and does not traverse descendants. Sources: `codex-rs/core/src/agent/control/interrupt.rs:21-41`; `codex-rs/core/src/session/mod.rs:5021-5027`; `codex-rs/core/src/tasks/mod.rs:539-563`.
- Interruption is not closure, permanent cancellation, or guaranteed continued idleness: after abort processing, pending work can start another turn. Source: `codex-rs/core/src/tasks/mod.rs:556-563`.
- Internal legacy `close_agent` persists a closed edge and calls `shutdown_agent_tree`, which snapshots live descendants and shuts those runtimes down. That behavior must not be attributed to V2 model `interrupt_agent`. Sources: `codex-rs/core/src/agent/control/legacy.rs:47-122`; V2 registration at `codex-rs/core/src/tools/spec_plan.rs:1302-1395`.
- V2 spawn records increasing depth but does not apply the V1 configured maximum-depth check in the V2 handler or availability gate. It remains constrained by execution/residency capacity and upstream child-model tool eligibility. Sources: `codex-rs/core/src/tools/handlers/multi_agents_v2/spawn.rs:131-154`; `codex-rs/core/src/tools/spec_plan.rs:672-682`; `codex-rs/core/src/agent/control/spawn.rs:648-677`.

## Cancellation and commit boundaries

- A newly created child is owned by `PendingSpawn` while analytics, persisted edge completion, optional fork-history materialization, and initial-input submission run. Only after accepted initial input does spawn commit registry metadata, commit residency, and disarm cleanup. Further awaits (status/config snapshots) occur **after** commit, so cancellation of the caller then does not undo that child. Source: `codex-rs/core/src/agent/control/spawn.rs:770-887`.
- Dropping an armed `PendingSpawn` launches detached cleanup: remove runtime, shutdown/wait, discard live storage, await any pending open-edge write, then mark that edge closed. Cleanup errors are logged. Registry and residency reservations separately release on drop. This is asynchronous cleanup, not a synchronous transaction rollback. Sources: `codex-rs/core/src/agent/control/spawn_guard.rs:10-74`; `codex-rs/core/src/agent/registry.rs:378-393`; `codex-rs/core/src/agent/control/residency.rs:34-46`.
- Once eviction submits shutdown, caller cancellation cannot revoke it. Eviction runs in a spawned task holding the exclusive residency gate and counted slot through removal; dropping the waiting reservation caller does not cancel that task. Source: `codex-rs/core/src/agent/control/residency.rs:177-212`.
- Controller delivery success means accepted, not read by a model. This audit does not extend the spawn rollback guarantee to already accepted follow-up operations. Source: `codex-rs/core/src/agent/api.rs:35-38,54-63`.

## Verification boundaries

All findings above were traced in the pinned source; no Rust test suite was run. Existing upstream tests explicitly exercise oldest-idle eviction (`codex-rs/core/src/agent/control/residency_tests.rs:23-70`) and registered-agent reload (`codex-rs/core/src/agent/control_tests.rs:827-830`). The test named `interrupted_v2_agent_is_lost_after_residency_eviction` is **not evidence that named V2 tool-spawned agents always become unreloadable**: its helper directly spawns `SubAgentSource::Other` and bypasses the named-agent registry path (`codex-rs/core/src/agent/control/residency_tests.rs:74-128,142-164`).
