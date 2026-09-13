# Codex V1 subagent contract

## Baseline and delivery boundary

The common model-facing baseline is Codex **rust-v0.145.0** /
`25af12f7e61572b0bc18ddb1008be543b91519b0`, also the existing Code Mode contract
and host pin. #305 amends #271; it does not upgrade the host or activate nested
subagents. [Revision evidence](../../../docs/code-mode-contract/subagents-revisions.md)
compares the old subagent pin and inspected checkout. The earlier
[research](../../../docs/code-mode-contract/subagents-research.md) remains historical evidence.

This is the target for #264, not certification of the unfinished integration.
Existing close work stays in place. #276 supplies retained-state ownership;
#277 supplies usable resume and reservation; #306 supplies shared operations and
cancellation; #307 aligns child collaboration and roles; #308 exposes nested
operations; #309 integrates presentation; #278 runs the combined parity audit.
Current read-only explorer configuration and child collaboration exclusions are
**implementation gaps**, not accepted platform adaptations. Keep partial nested integration inaccessible until coherent.

## One engine, two entry points

| Session configuration                      | Model-facing surface                               |
| ------------------------------------------ | -------------------------------------------------- |
| GPT-5.6/GPT-6 family with Code Mode active | Five `tools.multi_agent_v1__<name>` functions only |
| Other model or adapter disabled            | Same five operations as flat standalone Pi tools   |
| Subagents disabled                         | Neither surface                                    |

The operations are `spawn_agent`, `send_input`, `wait_agent`, `close_agent`, and
`resume_agent`. Do not expose aliases or both paths together. Preserve unrelated
direct tools, explicit tool selections, and agent identities across exposure
switches. Children select exposure from their own model and actual permitted
capabilities, not the parent's adapter state.

`subagents/` owns sessions, validation, role/model resolution, concurrency, message
delivery, approvals, Fleet, and recoverable conversation data. The composition root
`packages/ext/index.ts` supplies a session-owned capability/controller to the adapter.
Direct and nested entry points call the same operations; the adapter must not infer
executors from `getAllTools()` metadata or duplicate manager/authorization policy.
There is no runtime dependency from subagents to the adapter.

## Supported declarations and results

`codex-v1-contract.ts` supplies the supported direct contract. Reproducible generation
and its provenance are recorded in the revision evidence. Preserve exact supported
factory prose, including role guidance and argument/output documentation; never
abbreviate it for a token target. The deterministic factory configuration uses no
custom usage hint and no picker-visible model overrides. Runtime model catalogs
remain dynamic; a future catalog-aware factory must preserve upstream formatting.

| Operation      | Required input      | Optional input                                            | Successful result                            |
| -------------- | ------------------- | --------------------------------------------------------- | -------------------------------------------- |
| `spawn_agent`  | `message`           | `agent_type`, `fork_context`, `model`, `reasoning_effort` | `{ agent_id, nickname }` (nickname nullable) |
| `send_input`   | `target`, `message` | `interrupt`                                               | `{ submission_id }`                          |
| `wait_agent`   | `targets`           | `timeout_ms`                                              | `{ status, timed_out }`                      |
| `close_agent`  | `target`            | —                                                         | `{ previous_status }`                        |
| `resume_agent` | `id`                | —                                                         | `{ status }`                                 |

Status is `pending_init`, `running`, `interrupted`, `shutdown`, `not_found`,
`{ completed: string | null }`, or `{ errored: string }`. Wait's `status` maps selected
agent IDs to final statuses. Direct Pi results serialize these objects as JSON text;
nested success resolves to the object, not a Pi content envelope or JSON string.
Nested validation/execution failures reject. Renderer details are not model payloads.

Tool definitions and broader orchestration/model templates are separate. Preserve
additive Pi-bites, project, skill, and extension prompts rather than importing the
complete Codex system prompt or adding local batching advice.

## Roles, messaging, waits, and capacity

- Built-in roles are `default`, `worker`, and `explorer`. Explorer is role guidance,
  **not a read-only permission boundary**. Inherit actual parent tools, permissions,
  model, and reasoning unless a supported, authorized override applies. A role must
  neither grant missing capabilities nor manufacture an extra restriction.
- `fork_context: true` copies full parent history, inherits the parent role, and
  rejects explicit `agent_type`. False/omitted starts from the initial prompt and
  defaults to `default`. Preserve parent/child addressing, depth and capacity limits,
  target permissions, and descendant ownership. Replace the obsolete injected
  `MessageAgent` helper and unconditional collaboration exclusions in #307.
- Validate inputs and supported overrides before launching, reserving, or submitting.
  Reject empty messages and invalid targets. Reject incompatible fork/role selection.
  Native errors/defaults and revision-specific behavior are in the revision evidence;
  unsupported fields must not be silently accepted as working controls.
- `send_input` queues by default; `interrupt: true` interrupts current work before
  submitting input. Reuse an open completed agent for another turn. Preserve retained
  conversation and submission identity. Delivery occurs at Pi's next model boundary,
  not by injecting into an already ongoing inference.
- `wait_agent` observes only explicit selected targets and returns when any selected
  target has final status. Default timeout is 30,000 ms; positive values clamp to
  10,000–3,600,000 ms. A valid missing target reports `not_found`. Timeout returns `{ status: {}, timed_out: true }` without
  cancelling work. Final-status notification and selected wait are independent:
  both may contain the same completion. UI progress is neither delivery channel.
- Spawn fails immediately when capacity cannot be reserved; no invisible model-facing
  queue. Completed open agents retain slots until closed. Internal manager callers'
  explicit `queueIfBusy` is not a tool-level queue contract.
- Close returns the target's previous status and closes its open descendant subtree.
  Repeated close returns `shutdown`; unknown targets fail. Interruption alone does not
  release capacity. Preserve usable conversation and identity for explicit resume.
- Resume reserves capacity **during reopening, before new work**, commits the
  reservation after successful reopening, and releases it on failed reopening.
  Ordinary `spawn → close → resume → send → wait` must work. Reopening uses manager-owned
  recoverable data and current permissions, not a display tombstone treated as a live
  session. Storage/serialization mechanisms need not duplicate Codex internals.

## Retained close conversations (#276)

- Closing an ordinary in-memory child retains a detached active-branch conversation, child session
  id/cwd, agent id, role, parent identity, and description in `AgentManager.getClosedRecord(id)`.
  Closing disposes live resources, not conversation history. The snapshot includes the session header
  and active branch (including compaction history), with plain custom extension-state entries removed
  and remaining parent links and compaction boundaries repaired. It never retains the live session, callbacks, or approvals.
  Returned records are defensive copies; manager disposal clears all retained conversations.
- Persisted-session integrations without an available conversation snapshot retain their manager-owned
  path as before. Queued children that never create a session remain explicitly unrecoverable. Snapshot
  failure is an explicit close error, but teardown and capacity release still run exactly once.
- #277 consumes only this manager-owned lookup to reopen conversations; it must reconstruct extensions
  and revalidate current parent permissions, role/model/tool scope, and command authorization, not
  restore historical capabilities. Close does not implement resume or Code Mode dispatch.

### Close baseline verification (#276)

The `close_agent` target/previous-status schemas and description are unchanged at the shared Code Mode
pin `25af12f7e61572b0bc18ddb1008be543b91519b0` (`rust-v0.145.0`), verified against
`codex-rs/core/src/tools/handlers/multi_agents_spec.rs` and
`codex-rs/core/src/tools/handlers/multi_agents/close_agent.rs`. Flat direct-tool naming is the Pi
transport adaptation. The broader contract rebaseline belongs to #305; no close declaration rewrite
is needed. Pi serializes concurrent close requests per agent and returns `shutdown` to subsequent
callers; upstream does not guarantee concurrent status sampling order.

## Cancellation and navigation ownership

An agent is conversation/session-owned, not cell-owned. Outer `wait` resumes a cell;
`wait_agent` observes agents; `write_stdin` resumes a shell session. Normal cell
completion, `exit()`, or cell cancellation must not close committed children. Native
cell finalization still cancels unfinished delegates; it is not an atomic rollback
transaction for already committed agent effects.

The shared controller must implement these observable commit boundaries (#306):

| Operation        | Before commit                                                                                       | Commit / cancellation after commit                                                                                                                                                                            |
| ---------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spawn            | Check signal, owner generation, arguments and capacity; roll back failed uncommitted initialization | Publish child identity and reservation in the session-owned manager. A lost call result must leave the child discoverable/manageable through Fleet and owner controls; do not silently close it with the cell |
| Send / interrupt | Check current owner, target and signal before each irreversible effect                              | Interruption and accepted input are separate effects; do not claim an interrupted turn is restored if submission fails. Accepted input remains accepted if the result is lost                                 |
| Wait             | Validate selected targets and register a cancellable waiter                                         | Cancellation removes only this waiter; never close children or consume the independent notification                                                                                                           |
| Close            | Validate owner and target before shutdown                                                           | Once shutdown is requested, finish subtree teardown and retain recoverable state even if the caller disappears                                                                                                |
| Resume           | Validate owner, target and current permissions; reserve while reopening, release failed reservation | Publish reopened session before returning. Lost output must not hide the reopened identity or release a committed slot                                                                                        |

Use lifecycle generations and stable snapshots captured while Pi `ctx` is active.
Deferred callbacks, continuations, and timers must not dereference captured `ctx`.
Regression checks use throwing getters **and** owner invalidation so stale snapshots
cannot launch late-approved work.

An exposure/model switch restores direct/nested controls and preserves agents in the
same conversation. Session replacement, branch navigation, reload, and shutdown
invalidate the old owner's operations, waiters, approvals, and delivery destinations;
stop its live work and retain only explicitly recoverable conversation data. Do not
send old notifications into the new conversation. Saved transcripts restore display,
not cells, shells, approvals, or live agents. Explicit reopening revalidates ownership
and permissions. This navigation policy is a Pi adaptation, not a claim of native
atomic rollback. Keep agent cleanup separate from cell-owned shell cleanup.

## Supported platform adaptations

- Flat standalone Pi names replace the Responses namespace only on direct transport;
  nested names follow native namespace conversion, `multi_agent_v1__<name>`.
- Require plain-text `message` and omit Responses-only `items` from spawn/send. Replace
  only the corresponding either-message-or-items wording, recording the projection.
- Omit the selected pin's `service_tier` override: Pi cannot honor it. Do not accept an
  inert field or imply stock provider service-tier controls are a per-agent override.
- Direct Pi transport may omit output schemas on the wire. Preserve them as execution
  contracts and nested return declarations.
- Use stock providers/authentication and existing grammar capability detection with
  structured exec fallback. Bash-gate authorizes actual child commands; it does not
  implement Codex filesystem/network sandbox enforcement. Keep Auto Mode, per-command
  audit identity, queued human prompts, allowance rechecks, cancellation, and child-to-parent
  escalation. Discovery and outer JavaScript never authorize commands.
- Pi storage, internal communication, encryption, and UI need not replicate Codex.
  UI partial updates and next-model-boundary delivery do not promise immediate native
  Responses injection. Reuse subagent renderers within exec/wait traces and preserve
  Fleet/navigation; never manufacture duplicate model-visible tool messages.

## Discovery and measurement

Eligible sessions eagerly receive the existence of all five operations, their native
names, the discovery instruction, and policy needed **before** deciding to delegate:
spawn authorization/role guidance boundaries, disjoint ownership/no duplicate work,
capacity retention until close, independent selected wait/notification delivery,
agent-versus-cell lifetime, and actual inherited permissions. Complete declarations,
including every argument description/default and return type, are available through:

```js
text(ALL_TOOLS.filter((tool) => tool.name.startsWith("multi_agent_v1__")));
```

Read the returned help before use and rediscover after compaction removes it.
Discovery neither executes a tool nor changes availability or authorization. It must
work without Responses tool search. Deferring detailed V1 declarations on **every**
eligible Pi route is intentional local policy: upstream V1 is eager on routes without
search. Direct tools retain complete definitions. Eager cues are not shortened
substitutes for discoverable tool definitions.

Report distinct measurements, not a single budget:

1. Standalone five-tool serialized declarations (including output contracts for
   comparison), plus separately identified additive prompts.
2. Initial eager Code Mode instructions/capability/policy cues, before discovery.
3. Full discoverable metadata with declaration-bearing descriptions and return types.
4. Actual discovery output retained in conversation history, including transport
   wrapping; account again after rediscovery rather than claiming free deferral.
5. Actual provider request payloads on each available route: active tool schemas,
   system/developer prompts, history, and provider-reported input/cache usage where
   available. Record model/provider/transport and unavailable routes; character
   estimates are not exact tokenizer counts or guarantees of cache hits.

Historical evidence from #271: old three-tool estimate **1,605**; V1 serialized
`ceil(characters / 4)` estimate **2,902**, compared with a former soft target **2,000**.
These are comparison points, not an exact token count or a hard ceiling. No prose
shortening is authorized by the target. Nested eager/history/provider measurements
remain pending #308/#278 until the surface actually runs.

## Scenario-based parity checks

Run each scenario through (A) registered direct Pi tool execution and (B) native
`exec` using the matching `tools.multi_agent_v1__<name>`. Compare parsed direct JSON
to nested objects and semantic errors; exclude renderer-only metadata. Use controlled
child turns and clocks/signals, not arbitrary sleeps. These are acceptance scenarios
for the named follow-ups, not new prompt-only tests or claims that B is active today.

| Scenario                       | Observable check                                                                                                                                                                                                                                          | Delivery  |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| Definitions and bad input      | All five names; omitted defaults; unknown fields, empty message/targets, malformed/unauthorized ID, invalid timeout, unknown role/model/effort, fork plus explicit role reject without side effects; missing target fails except wait returns `not_found` | #306–#308 |
| History and capabilities       | No-fork defaults to default; full-history fork sees prior turns and inherits role; children inherit actual tools/model/reasoning; explorer can use a permitted write tool and cannot gain a forbidden tool                                                | #307      |
| Concurrent spawn               | Race two spawns for one slot; only one commits; completed open child still blocks spawn; failed initialization releases reservation                                                                                                                       | #306      |
| Input and addressing           | Send during initialization/running/completion, child-to-parent and permitted descendant addressing, forbidden target, interrupt then reuse; preserve turns and submission IDs                                                                             | #307      |
| Selected wait and notification | Unselected completion does not release wait; selected completion does; timeout is empty; multiple selected finals preserved; notification still arrives independently                                                                                     | #306–#307 |
| Close/resume                   | Close running/completed subtree once; repeat close; unknown ID error; reopen ordinary child with same identity and prior conversation; resume at capacity fails; simultaneous resume reserves before work; failed reopen rolls back                       | #276–#277 |
| Cancellation races             | Abort before initialization/approval/submission commits prevents late work; abort after commit keeps identity manageable; interrupted-but-unsubmitted send does not claim rollback; cancelled wait leaves child alive                                     | #306      |
| Three lifetimes                | Spawn then normal cell end, exit, cancellation, and unhandled sibling rejection; committed child survives; shell cancellation remains cell-scoped; outer wait never acts as agent wait                                                                    | #308      |
| Exposure and navigation        | Supported-model switch and direct/nested fallback preserve IDs and controls, no duplicates, explicit selections survive; disabled subagents expose neither; child model selects independently                                                             | #308      |
| Owner invalidation             | Throwing stale ctx, branch/session/reload/shutdown during initialization or queued approval: no late launch, old-owner notification, inaccessible work, or restored authorization                                                                         | #306/#309 |
| Presentation and routes        | Structured nested errors, progress, Fleet/navigation, images, restored and expanded traces; no raw JS by default or duplicate model output; actual grammar and structured-fallback routes                                                                 | #309/#278 |
| Discovery/accounting           | Complete ALL_TOOLS declarations without search, rediscovery after compaction, separate eager/discoverable/history/provider measurements                                                                                                                   | #308/#278 |

Existing focused behavioral checks cover direct spawn, send, wait, and close. Run
those and final `bun check` for this rebaseline; #278 records actual live-route coverage
and any unavailable routes after the remaining implementation lands.
