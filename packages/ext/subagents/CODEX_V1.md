# Codex V1 subagent contract

## Baseline and delivery boundary

The common model-facing baseline is Codex **rust-v0.145.0** /
`25af12f7e61572b0bc18ddb1008be543b91519b0`, also the existing Code Mode contract
and host pin. #305 amends #271; it does not upgrade the host or activate nested
subagents. [Revision evidence](../../../docs/code-mode-contract/subagents-revisions.md)
compares the old subagent pin and inspected checkout. The earlier
[research](../../../docs/code-mode-contract/subagents-research.md) remains historical evidence.

The lifecycle, shared controller, child collaboration, exposure, and presentation work
is integrated on `subagents-codex`. The [combined validation record](../../../docs/code-mode-contract/subagents-validation.md)
records #278's parity corrections, automated checks, actual provider payloads, and live-route
limitations. Integration into `master` remains a separate maintainer/runner action.

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
Pi agent/session IDs are opaque manager-owned identifiers, not Codex ThreadId UUIDs;
unknown strings use the local lookup error (or `not_found` for wait). No arbitrary
session path is accepted. Model lookup and initialization errors retain Pi provider
and scope diagnostics rather than pretending to be Codex backend errors.

Tool definitions and broader orchestration/model templates are separate. Preserve
additive Pi-bites, project, skill, and extension prompts rather than importing the
complete Codex system prompt or adding local batching advice.

## Roles, messaging, waits, and capacity

- Built-in roles are `default`, `worker`, and `explorer`. Role names are trimmed
  and case-sensitive; blank means omitted, including on full-history forks. Explorer is role guidance,
  **not a read-only permission boundary**. Inherit actual parent tools, permissions,
  model, and reasoning unless a supported, authorized override applies. A role must
  neither grant missing capabilities nor manufacture an extra restriction.
- `fork_context: true` copies full parent history, inherits the parent role, and
  rejects a nonblank explicit `agent_type`. False/omitted starts from the initial prompt and
  defaults to `default`. Preserve parent/child addressing, depth and capacity limits,
  target permissions, and descendant ownership. Children register the same V1 operations;
  there is no separately injected parent-message tool.
- Validate inputs and supported overrides before launching, reserving, or submitting.
  Reject empty messages and invalid targets. Reject incompatible fork/role selection.
  Native errors/defaults and revision-specific behavior are in the revision evidence;
  unsupported fields must not be silently accepted as working controls.
- `send_input` queues by default; `interrupt: true` interrupts current work before
  submitting input. Reuse an open settled agent after completion, error, or interruption for another turn.
  `interrupt: true` on a settled or newly resumed conversation submits input without
  requiring a running turn to abort. During initial session creation, interrupting input
  fails explicitly until a live session exists; ordinary input can queue. Preserve retained
  conversation and submission identity. Delivery occurs at Pi's next model boundary,
  not by injecting into an already ongoing inference.
- `wait_agent` observes only explicit selected targets and returns when any selected
  target has final status. `interrupted` is not final: wait continues through the next
  turn, times out, or observes close; interruption alone sends no final notification. Default timeout is 30,000 ms; positive values clamp to
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
- `resume_agent` consumes only this manager-owned conversation lookup. Path-only legacy records,
  missing snapshots, and corrupt snapshots fail explicitly; no filesystem session search or arbitrary
  path reopening occurs. Recovery is manager-lifetime memory, not cross-process persistence.

## Recoverable resume (#277)

- `AgentManager.reopen` preserves agent/session identity, parent, role, description, active history and
  compaction. It builds a fresh child using the current parent's model, reasoning, provider registry,
  project configuration and system prompt. It checks current model availability and enabled model
  scope, intersects the role's tools with current parent active tools, and reconstructs the command
  authorization gate. Historical model/tool settings, extension state, approvals, cells and processes
  do not become live capabilities. Parent messaging remains bound to the original parent identity.
- A reopened child has `pending_init` status until input starts a turn, matching the pin's new thread
  status. Internally an explicit idle state reserves generation one for the first input; it is not queued
  for capacity. Waiters registered while idle follow that first turn, or observe shutdown if it closes. `send_input`, Fleet steering and selected-target waits use the same retained-turn
  paths as spawned agents. Resume alone never sends a synthetic user message or completion.
- Reserve before loading and retain the slot while the reopened child is open. Concurrent resumes
  join one reopen; an already-open request returns current status without another slot. Unknown,
  foreign-owned, closing and unrecoverable targets fail deterministically. A close during reopening
  waits for that claim before closing the resulting session.
- Cancellation before entry does nothing. Cancellation during initialization prevents publication,
  tears down any acquired session and releases the reservation once initialization settles; callers
  joining another reopen can cancel their own wait without cancelling its owner. Failure retains the
  owned snapshot for retry. Manager shutdown cancels and awaits reopen claims. Direct calls also carry
  the current lifecycle owner's signal, so session replacement cannot publish late reopened agents.
  Publication into the manager is the commit point: cancellation or a lost result afterward leaves
  the agent discoverable and controllable, still holding its slot.
- Nested exposure and broader child role/permission parity remain #307–#309 work. The
  standalone success payload is the pinned `{ status }` object serialized as text; failures throw
  model-facing errors and update the same bounded call renderer. Focused manager tests cover claims,
  rollback, owned lookup and stale contexts; a real Pi-session check exercises conversation/compaction,
  fresh tools and the complete spawn-close-resume-send-wait workflow with a controlled provider.

### Close baseline verification (#276)

The `close_agent` target/previous-status schemas and description are unchanged at the shared Code Mode
pin `25af12f7e61572b0bc18ddb1008be543b91519b0` (`rust-v0.145.0`), verified against
`codex-rs/core/src/tools/handlers/multi_agents_spec.rs` and
`codex-rs/core/src/tools/handlers/multi_agents/close_agent.rs`. Flat direct-tool naming is the Pi
transport adaptation. The broader contract rebaseline belongs to #305; no close declaration rewrite
is needed. Pi serializes concurrent close requests per agent and returns `shutdown` to subsequent
callers; upstream does not guarantee concurrent status sampling order.

## Child collaboration (#307)

Every embedded child receives a registrar from its root-owned manager at the shared
extension/session-tree boundary. Registration creates a caller-bound controller and
delivery endpoint, not another manager, Fleet, approval broker, or capacity counter.
The global async role marker stays string-compatible with older installed entrypoints
that resource discovery may evaluate before filtering; the registrar has its own
async-local slot. Raw/isolated SDK runners without a root registrar have no collaboration.

The child's `capture(ctx)` publishes its own `model` and permitted `capabilities`,
alongside the caller-bound executor. Parent and child model families may differ;
the inherited underlying tool ceiling and the child's actual active selection both
remain authoritative. These are standalone capabilities here; #308 projects them into
exactly one direct/nested surface. No third-party executors are inherited.

V1 addresses known agent IDs within the same root conversation, including siblings
and descendants, rather than arbitrary Pi sessions. Root identity survives retained
close/resume. Child guidance supplies its immediate parent's session ID for
`send_input`; this uses the same queued-message state machine and sender identity
as the existing parent delivery channel. Final notifications route to the owning
parent node, independently of explicit waits, including across retained turns.
Neither channel promises injection into active inference.

The pinned defaults are six open slots shared across the whole root tree and maximum
depth one (root depth zero). Completed open agents retain slots. Set `maxDepth: 2`
in `.pi/subagents.json` (or the global `subagents.json`) to permit grandchildren;
`maxConcurrent` adjusts the same root budget. Settings load from the active root cwd,
not separately in each child. Depth is checked before spawn and resume reservation.
Closing a subtree invalidates child captures and cancels pending descendant reopen
claims, including claims initiated by a different same-tree caller. A descendant
cannot reopen while its owning parent remains closed.

Pi transport limitations: parent-session `send_input` is queued, not interrupting;
self/ancestor `close_agent` from that descendant's own tool call is rejected because
waiting for the calling Pi invocation to tear down would deadlock. External/root close
still shuts down the complete owning subtree. These limits do not add a V2 task hierarchy.

Explorer is additive role guidance and uses the same builtin baseline as default and
worker. Full-history forks inherit and validate the parent role; prompt-only children
default to default. Actual parent/user/project restrictions and bash-gate authorization
remain in force. The obsolete helper and its renderer are removed.

Verification covers shared depth/capacity, same-tree and foreign-root targeting,
throwing-getter captures, reopen cancellation, independent retained delivery, real
supported/unsupported child sessions, and two-hop approval forwarding. Live provider smokes and nested execution evidence are in the combined validation record.

## Shared owned operations (#306)

`createSubagents` returns a `SubagentController`; `packages/ext/index.ts` injects it into
standalone registration with `registerTools()`. The root also injects the adapter's
`getAllowedTools()` snapshot when enabled: it reconstructs permitted capabilities
without changing the parent's exposure, so Code Mode names cannot strip core tools
from a child choosing another model or revive explicitly excluded capabilities.
The five owned tool factories supply
one implementation, pinned definitions and reusable renderers. The controller exposes
`capture(ctx, { forkContext })` for deferred consumers; it never discovers executors
through `getAllTools()`, emits synthetic Pi tool events, or imports the adapter.
The adapter exposes these operations through the scoped #308 integration.

Capture happens while Pi ctx is active. The returned operation handle contains the
parent identity, role, model/reasoning, scope policy, allowed tools, provider/model
registry snapshots, system prompt and explicitly requested fork history. Calls carry
`callerId`, a nonempty unique in-flight `callId`, cancellation and optional display
updates. All five direct tools use this same schema/ownership/generation gate. Success
returns a typed V1 `value` alongside Pi text and display `details`; failures throw,
including cancelled waits. Lost display callbacks cannot cancel owned work.

Spawn publishes its identity and capacity synchronously, before asynchronous child
initialization. Cancellation before publication prevents launch; after publication,
initialization and eventual errors belong to the retained agent, observable through
Fleet and wait/close. No cell signal is attached to a committed child. Resume instead
reserves while loading and publishes only after initialization; failure or cancellation
before that publication tears down and releases its claim. Send commits at manager
submission (or at the serialized interruption effect); cancellation is checked before
a queued interruption begins, not presented as rollback after acceptance. A cancelled
wait removes only its timers/listener, never the agents or another waiter.

Session replacement/reload/shutdown invalidate captured operations. Branch navigation
also cancels approvals, closes old live conversations into manager-owned recovery data,
and suppresses their late conversation messages/notifications in the new branch.
Canonical completion still resolves waiters, emits lifecycle events and clears Fleet
and session-tracker background activity. Existing manager,
Fleet and RPC paths remain supported, without becoming the nested execution boundary.

Focused regression checks are in `test/operations.test.ts`, with existing manager
reopen/interruption and standalone renderer suites covering the underlying lifecycle.

## Cancellation and navigation ownership

An agent is conversation/session-owned, not cell-owned. Outer `wait` resumes a cell;
`wait_agent` observes agents; `write_stdin` resumes a shell session. Normal cell
completion, `exit()`, or cell cancellation must not close committed children. Native
cell finalization still cancels unfinished delegates; it is not an atomic rollback
transaction for already committed agent effects.

The shared controller implements these observable commit boundaries (#306):

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
shortening is authorized by the target. The combined validation record reports eager/history/provider measurements separately.

## Scenario-based parity checks

Run each scenario through (A) registered direct Pi tool execution and (B) native
`exec` using the matching `tools.multi_agent_v1__<name>`. Compare parsed direct JSON
to nested objects and semantic errors; exclude renderer-only metadata. Use controlled
child turns and clocks/signals, not arbitrary sleeps. Both paths are active; the combined validation record maps these scenarios to the
existing behavioral seams and distinguishes controlled sessions from live inference.

| Scenario                       | Observable check                                                                                                                                                                                                                                          | Delivery  |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| Definitions and bad input      | All five names; omitted defaults; unknown fields, empty message/targets, malformed/unauthorized ID, invalid timeout, unknown role/model/effort, fork plus explicit role reject without side effects; missing target fails except wait returns `not_found` | #306–#308 |
| History and capabilities       | No-fork defaults to default; full-history fork sees prior turns and inherits role; children inherit actual tools/model/reasoning; explorer can use a permitted write tool and cannot gain a forbidden tool                                                | #307      |
| Concurrent spawn               | Race two spawns for one slot; only one commits; completed open child still blocks spawn; failed uncommitted reopen releases reservation; published spawn errors retain their slot until close                                                             | #306      |
| Input and addressing           | Send during initialization/running/completion, child-to-parent and permitted descendant addressing, forbidden target, interrupt then reuse; preserve turns and submission IDs                                                                             | #307      |
| Selected wait and notification | Unselected completion does not release wait; selected completion does; timeout is empty; multiple selected finals preserved; notification still arrives independently                                                                                     | #306–#307 |
| Close/resume                   | Close running/completed subtree once; repeat close; unknown ID error; reopen ordinary child with same identity and prior conversation; resume at capacity fails; simultaneous resume reserves before work; failed reopen rolls back                       | #276–#277 |
| Cancellation races             | Abort before initialization/approval/submission commits prevents late work; abort after commit keeps identity manageable; interrupted-but-unsubmitted send does not claim rollback; cancelled wait leaves child alive                                     | #306      |
| Three lifetimes                | Spawn then normal cell end, exit, cancellation, and unhandled sibling rejection; committed child survives; shell cancellation remains cell-scoped; outer wait never acts as agent wait                                                                    | #308      |
| Exposure and navigation        | Supported-model switch and direct/nested fallback preserve IDs and controls, no duplicates, explicit selections survive; disabled subagents expose neither; child model selects independently                                                             | #308      |
| Owner invalidation             | Throwing stale ctx, branch/session/reload/shutdown during initialization or queued approval: no late launch, old-owner notification, inaccessible work, or restored authorization                                                                         | #306/#309 |
| Presentation and routes        | Structured nested errors, progress, Fleet/navigation, images, restored and expanded traces; no raw JS by default or duplicate model output; actual grammar and structured-fallback routes                                                                 | #309/#278 |
| Discovery/accounting           | Complete ALL_TOOLS declarations without search, rediscovery after compaction, separate eager/discoverable/history/provider measurements                                                                                                                   | #308/#278 |

Run the focused checks and final `bun check` listed in the combined validation record.
