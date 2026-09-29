# Codex V2 six-tool contract (#346)

## Pin and reproducibility

The subagent declaration baseline is OpenAI Codex
`1a89aec960cd92e2c59ce49b7f3c3347a915e4a9`. This does **not** upgrade the Code Mode
host, vendor source, or V1 historical baseline. No executor is imported or registered
by `codex-v2-contract.ts`.

```sh
python3 scripts/generate-subagents-v2-contract.py /path/to/codex
python3 scripts/generate-subagents-v2-contract.py /path/to/codex --check
```

The generator reads immutable `git show <revision>:<path>` blobs, not checkout HEAD
or working-tree files. It uses Python's standard library and Git only. `--check`
compares parsed JSON without writing; formatter whitespace is immaterial. Existing
manifest mismatches fail even in write mode. The extractor intentionally handles
only the pinned Rust factory shapes, not arbitrary Rust.

- [Source manifest](../../../docs/code-mode-contract/subagents-v2-source-manifest.json):
  source paths and SHA-256 hashes, including upstream LICENSE/NOTICE.
- [Generated declarations](../../../docs/code-mode-contract/subagents-v2-supported.json):
  unmodified native factory schemas/prose, supported projection, field-by-field edits,
  configuration, status schema, result evidence, and deterministic contract hashes.
- [Audit](../../../docs/code-mode-contract/subagents-v2-audit.md) and
  [lifecycle evidence](../../../docs/code-mode-contract/subagents-v2-upstream-lifecycle.md):
  handler/control-level validation and lifecycle findings.

The deterministic profile enables all six operations, built-in default/explorer/worker
roles, exposed role/model/reasoning inputs, hidden spawn result metadata, no custom
usage hint/description, and an empty picker-visible model catalog. These are explicit
factory inputs, not a claim that Pi has no runtime model registry. Hidden spawn
metadata controls the result (`task_name` only); it does not remove V2 role inputs.

`CODEX_V2_CONTRACT.tools` is keyed by the six names below. Each entry has `name`,
`description`, `parameters` (plain JSON Schema, suitable for a TypeBox `TSchema`
cast at registration), and `output_schema` (null for upstream text-only results).
No nested declarations, discovery metadata, namespaces, or executors are generated.
Descriptions and role guidance are retained in full, not shortened for a token budget.

## Inputs and actual results

| Tool              | Required               | Optional                                                | Success                                  |
| ----------------- | ---------------------- | ------------------------------------------------------- | ---------------------------------------- |
| `spawn_agent`     | `task_name`, `message` | `fork_turns`, `agent_type`, `model`, `reasoning_effort` | `{task_name: canonicalPath}`             |
| `send_message`    | `target`, `message`    | —                                                       | Empty text                               |
| `followup_task`   | `target`, `message`    | —                                                       | Empty text                               |
| `wait_agent`      | —                      | `timeout_ms`                                            | `{message, timed_out}`                   |
| `interrupt_agent` | `target`               | —                                                       | `{previous_status}`                      |
| `list_agents`     | —                      | `path_prefix`                                           | `{agents: [{agent_name, agent_status}]}` |

All input objects reject unknown properties. Descriptions are not validators: the
handler constraints below must also be enforced by the runtime. Upstream locations
are relative to `codex-rs/` at the pin.

- **Spawn:** `core/src/tools/handlers/multi_agents_v2/spawn.rs:121-159,261-319`
  and `message_tool.rs:32-38` validate nonblank messages and fork selection.
  Missing/blank `fork_turns` means `all`; trimmed `all`/`none` are case-insensitive;
  otherwise a positive integer string selects recent task turns, not last N messages.
  Legacy `fork_context` is explicitly rejected. Full forks permit an explicit role.
  `protocol/src/agent_path.rs:54-71,125-180` permits lowercase ASCII letters, digits,
  underscores; rejects empty/reserved `root`, `.`, `..`, and slashes in a task segment.
  Canonical names join the caller's path; duplicate paths fail. Native selected
  result is `HiddenMetadata`, not the V1 ID/nickname object.
- **Messaging:** `message_tool.rs:16-38,57-115` rejects blank messages and returns
  `FunctionToolOutput::from_text(String::new(), Some(true))`. There is no fabricated
  submission ID, JSON acknowledgment, or native output schema. `send_message.rs`
  uses QueueOnly; `followup_task.rs` uses TriggerTurn. Queue-only idle delivery must
  not start a model turn. Follow-up rejects root; already running work receives input
  without a concurrent second turn. Both identities must belong to the same registry
  (`core/src/agent/control/api.rs:120-157`).
- **Wait:** `wait.rs:48-63,132-182` deserializes optional signed integer milliseconds:
  default **30,000**, minimum **10,000**, maximum **3,600,000**. Lower values (even
  negative integers) clamp and append a notice; higher values error. Fractions fail.
  Existing pending mail, subsequent mail, or steered user input wakes the wait; it
  does not consume mail, wait for selected agents, or return their final statuses.
- **Interrupt:** `interrupt_agent.rs:44-74` and
  `core/src/agent/control/interrupt.rs:16-50` return the status sampled **before** the
  request. Root and self are rejected. Only the selected turn is interrupted; this
  is not recursive close or identity deletion. An unloaded known target is not
  reloaded just to interrupt and can report `not_found`.
- **List:** `list_agents.rs:41-91` and `core/src/agent/control.rs:348-418,654-665`
  return loaded root/agents, including terminal agents, not all recoverable identities.
  Prefix is a canonical/relative task path without trailing slash; matching is exact
  or slash-delimited descendant, not arbitrary string prefix. Unloaded known
  identities remain addressable but are absent from the list.

Status is `pending_init`, `running`, `interrupted`, `shutdown`, `not_found`,
`{completed: string | null}`, or `{errored: string}`. Preserve output contracts even
when the ordinary Pi tool transport does not transmit an output schema.

## Explicit supported projection

1. Drop the Responses-only `encrypted: true` annotation from the three message
   properties. Pi transport/storage/security are not Codex Responses encryption.
2. Change wait's parameter type from native factory `number` to `integer`, matching
   actual `Option<i64>` deserialization. No minimum is added because low values clamp.
3. Correct **only** wait's misleading updating-agent-name promise. The pinned factory
   says “a summary of which agents have updates (if any)”; the handler returns no
   agent names. Supported prose says “a mailbox-activity summary without agent names”.

Actual wait messages are exactly `Wait completed.`, `Wait interrupted by new input.`,
or `Wait timed out.`. Only the last sets `timed_out: true`. Clamping appends
`\n\nRequested timeout of {requested_timeout_ms}ms was clamped to the minimum of {timeout_ms}ms.`
Do not invent an `agents` field to satisfy the erroneous factory prose.

The chosen delivery boundary is six **direct ordinary Pi tools on every permitted
model/provider**, including when Code Mode is active. No V1 aliases, V2 namespace,
`ALL_TOOLS` collaboration entries, or `tool_search` are part of this contract.
Upstream also recognizes the special infrastructure path `/morpheus`
(`protocol/src/agent_path.rs:125-180`). Pi does not implement that infrastructure
root: supported canonical paths belong to the current `/root` conversation tree;
`/morpheus` is unsupported, not an alternate root or an authorization escape.

Inherited authorization, explicit selection, extension disables, and owner generation
checks still apply. Native timing prose is source provenance, not evidence Pi can
inject into active inference: Pi delivery occurs at its supported model/tool boundaries.
Residency, mailbox timing, capacity, and child-history implementation/verification
belong to the runtime, not this metadata generator.

## Verification boundary

The [release validation record](../../../docs/code-mode-contract/subagents-v2-validation.md)
separates live GPT results, offline checks and pending maintainer disposition of
unverified routes/scenarios. It does not certify a completed release.

Generation followed by `--check` verifies reproducibility against all pinned source
hashes and generated declarations. This is source/contract evidence, **not** a native
Codex execution test or live provider compatibility claim. Runtime behavior and
provider payloads require the implementation's behavioral tests and smoke routes;
unavailable routes must remain explicitly unverified. No host pin change is needed.

## Direct activation (#352)

Ordinary extension activation registers all six V2 tools through the shared controller.
There is no staging entrypoint, V1 executor, dual-mode option, nested collaboration,
or discovery prerequisite. The manager, Fleet/navigation, approvals, runner, provider
registry and selected-tool intersection remain authoritative. Tools are direct on GPT,
Anthropic and other Pi tool-calling routes, with or without Code Mode. Children inherit
permitted tools and get canonical self/parent task paths plus V2 message/task guidance.
Project/skill policies stay additive; spawn prompt guidelines retain explicit delegation
permission requirements separately from the pinned descriptions.

Internal programmatic spawns receive generated task segments when not supplied, so
their children use the same task tree. Registry spawn returns a promise resolving at
the initialized-session handoff; RPC replies still carry an ID after awaiting it.
Both use shared residency admission and snapshot dependencies before awaiting; owner
replacement cancels uncommitted admission. Internal close/recovery operations remain for
lifecycle management, not as model-callable V1 tools. Old notification messages and
generic saved-tool/Code Mode result displays remain readable without restoring agents.

Full history is the default; `none` is fresh. Empty/whitespace fork selection means
`all`, and the two keywords are case-insensitive. Positive integer strings select
recent instruction/task turns as described below. Pi imports the active
context entries and performs ordinary cross-provider history conversion: a pending
spawn call gets a synthetic missing-result error, while existing results are retained.
Role overrides add instructions and cannot widen the parent's selected tools.

A task path is reserved synchronously with the manager record. Named spawn commits
at the initialized-session handoff immediately before the runner's first prompt,
not after the first model response. This Pi boundary differs from Codex's accepted
initial-input boundary. Before handoff, owner/caller cancellation aborts initialization;
failure tears down the record and releases its path and capacity. After handoff,
caller result loss does not cancel the child: the loaded task remains discoverable
through list/Fleet and manageable by the shared manager. Paths remain reserved when
a settled runtime unloads. Terminal named tasks release execution capacity; residency-pressure admission and
reload follow the policy below.

The tests exercise direct tools, shared operations and real Pi sessions with a canned
provider, including full/fresh imports, additive policy, selected tools, Code Mode
coexistence and Pi's shared Anthropic/OpenAI history transformer. See [cutover verification](../../../docs/code-mode-contract/subagents-v2-cutover.md)
for the offline payload matrix and live-route limitations. Existing source-audit reports describe the inspected
baseline, not a claim that later mailbox/residency slices are already implemented.

## Loaded-agent messaging (#347)

Direct messaging validates text and root-tree membership before native delivery.
Relative paths resolve beneath the caller; canonical paths permit parent and sibling
communication. Sender task paths and message text are attributed in model content;
activity IDs and interaction status remain display/bookkeeping metadata. Both tools
return empty text, without V1 submission receipts. Known unloaded targets reload
under the residency policy below.

`send_message` uses Pi's explicit `{triggerTurn: false}` custom-message path. Pi
persists idle mail immediately and appends running mail after the complete tool
batch. It does not request a model turn. The messenger tracks only activity IDs and
whether an unseen message requests work, not a second payload queue. Observation
returns pending counts and an arrival revision without consuming mail. IDs leave
pending state when Pi prepares a request context containing them, not when history
is appended; this is request preparation, not proof of provider receipt. Later
context filters or provider failures can still prevent inference.

`followup_task` rejects root. Running tasks request Pi `agent_before_settle`
continuation when follow-up activity remains unseen, without abort/restart. Idle
work starts through the existing manager/runner, preserving usage and session events.
Idle follow-up uses a tagged native custom-message continuation,
`Continue with the queued follow-up task.`, while the attributed task content
appears once. This scheduling message is not a new user/task boundary. The manager also drains work accepted in the
gap between native settlement and manager completion. Admission and delivery have
no intervening await; concurrent calls cannot double-start. Idle follow-up at full
execution capacity fails before delivery rather than creating an invisible queue.

Native acceptance is the commit point: later caller cancellation does not retract
accepted input. Invalidated captures cannot deliver or start work; disposed messenger
endpoints do not touch invalidated extension APIs. Fleet retains idle rows with
pending messages, and direct result metadata updates the call row without adding
model-visible acknowledgments. The integration tests use real Pi and a canned provider;
live GPT/Anthropic timing and residency/recovery remain unverified here.

## Completion mail and mailbox waits (#348)

The V2 completion path queues attributed final answers through the same
native queue-only messenger as information messages. Each completed generation
delivers once, including later follow-up turns; stopped/interrupted turns do not
send finals. Failures queue attributed failure text. Fleet/status/usage events
remain separate from model content; completion metadata styles the single incoming
message instead of adding a second result notification. Idle completion never
requests a parent model turn. No V1 completion executor remains.

Direct `wait_agent` accepts only the supported integer `timeout_ms`, with the
default, limits, notice and generic summaries documented above. It subscribes to
the caller's mailbox, not agent terminal states. Pending mail returns immediately;
arrival wakes all current waits without consuming or copying messages. Only context
preparation acknowledges activity IDs. Cancellation/replacement releases listeners
and timers without closing agents or consuming pending mail.

Pi's `input` hook precedes queue insertion and later hooks may asynchronously delay
or handle the input. The messenger observes interactive/RPC input without changing
it, then checks the extracted pending-user-input predicate every 25 ms while a wait
exists. It does not wake merely because the input hook fired. Pi has no extension
post-enqueue event; replace this bounded polling with that event if Pi exposes one.
The timer never dereferences a captured context: the predicate is extracted while
active, guarded against runtime invalidation, and polling stops on completion,
cancellation or messenger disposal. This guarded capability is runtime-bound, not
an assertion that extracted Pi methods survive replacement. Handled input does not
wake a wait, and accepted input remains in Pi's normal queue.

Real-Pi scheduling regressions delay a downstream input handler before enqueue,
exercise handled input, and verify the next request receives input once. Canned
child-provider tests cover repeated completion delivery; real idle parent sessions
verify zero unsolicited requests. Focused tests cover timeout/clamping, ownership,
throwing getters, UI outcomes and cleanup. Live provider timing remains unverified.

## Turn interruption (#349)

`interrupt_agent` uses root-tree lookup, rejects root/self, and permits siblings and
non-root ancestors. Unknown targets fail lookup; known unloaded identities report
`not_found` without reloading. Settled targets return their existing status unchanged.
The result snapshots status before submitting a stop, not after native settlement.
Repeated requests do not close the conversation or traverse descendants.

The shared turn interrupter clears Pi steering/follow-up queues and aborts only the
selected session run. Native cancellation propagates through bash-gate authorization,
Auto Mode review and human dialogs; late approvals cannot launch commands. Identity,
incarnation, transcript, mailbox and descendants remain intact. Interrupted output
is partial, not a completed final; completion mail is suppressed and Fleet shows
`interrupted` rather than `shutdown`. Usage and lifecycle events retain abort metadata.

A follow-up submitted during interruption waits cancellably for the old turn to
settle before committing input. Parent replacement or cancellation before that commit
prevents delivery. Already accepted input is not rolled back, and interruption does
not promise that pending mailbox work can never resume. These regressions use the production direct registration and real Pi sessions with canned
providers, not live-provider timing.

## Recent instruction/task forks (#350)

`fork_turns` accepts trimmed positive integer strings through the pinned 64-bit
`usize` ceiling (18446744073709551615), including leading `+` and zeroes. Zero,
negative/fraction/exponent values, overflow, nonstrings, and legacy `fork_context`
fail before spawn. Missing/blank means `all`; keywords are case-insensitive.
Counts above available turns retain from the first surviving boundary, not startup
context. With no surviving boundary, the imported context is empty. Full/fresh
selection and model/role/reasoning authorization remain on the shared spawn path;
recent forks apply the selected/default role rather than full-fork role inheritance.
The direct row shows the normalized fork choice.

Recent forks count projected real user instructions and attributed `followup_task`
messages. Delivery persists `details.task` only for turn-triggering tasks; queue-only
information, completion mail, assistant responses and tool iterations do not count.
Idle continuations use `subagent-task-continuation` custom messages instead of
synthetic user messages. Native custom-message scheduling avoids replaying input
hooks for this internal instruction. Older histories without task provenance cannot
retroactively distinguish task mail from information and are not inferred from text.

Pi's `buildSessionProjection` applies context edits before selection. Selected
messages are materialized into independent session entries, retaining custom-message
attribution and edited tool output without dangling edit/compaction references.
Compaction/branch summaries and historical system deltas are excluded from recent
forks: they can cover older tasks or depend on omitted state. The runner constructs
the child's own additive system prompt and permitted tools. Only active context is
available; a compacted mid-task prefix without an instruction is not another task,
and summarized-away turns cannot be recovered. Orphan tool results whose calls were
omitted are discarded. Stock Pi provider conversion supplies missing-result errors
for unfinished calls, including the currently executing spawn; completed pairs stay
intact. Runtime replacement fork is not used and parent entries remain unchanged.

Direct real-Pi/canned-provider tests cover recent selection, attributed idle follow-up,
parent independence, explicit cross-provider child model selection and throwing stale
context getters. Compaction/edit fixtures pass stock OpenAI Responses conversion and
Anthropic payload construction intercepted before transport, including tool pairing.
These checks are offline conversion evidence, not live provider acceptance.

## Execution capacity and retained residency (#351)

Named tasks release their execution reservation when a turn settles, while their
Pi runtime may remain loaded. The local `maxConcurrent` setting still counts **child
agents**, not root plus children. It independently bounds executing tasks and loaded
child runtimes (including initialization/reload claims). No additional setting or
waiting queue is introduced. Unlike the upstream four-total-thread default and
advisory execution admission, local reservations enforce the configured ceiling.
Role tool intersections, model scope and delegation-depth restrictions still apply.

When a new runtime needs a slot, admission unloads the least-recently-touched eligible
terminal runtime. Completion, input/reload and opening a conversation viewer touch
the runtime. Active/unsettled turns, protected viewers/operations, and pending mail
are ineligible. Native pending input and the messenger's unseen activity are checked
separately: persisted queue-only history is not evidence that mail has been read.
No eligible slot produces an explicit error. Concurrent admission claims count
before teardown starts; a reduced ceiling may require several eligible unloads.

Unloading preserves the same manager record, canonical path, session ID, transcript,
generation, usage, descendants and ownership. It invalidates the runtime incarnation
and approval allowances, not the conversation. Fleet/history label unloaded history;
saved messages and usage are not represented as a restored live runtime. An open
retained-history viewer stays an explicitly read-only snapshot if another operation
reloads the identity; reopen the viewer to follow its live session. Descendant
completion arriving while a parent is unloaded is retained in a live-manager mailbox
and queued into Pi after successful reopening, without starting a parent turn.

Both `send_message` and `followup_task` can reopen owned unloaded identities. Reopen
retains the child's model (which must still be authorized and in scope), role,
thinking and conversation ID, and intersects its delegated tool ceiling with the
current caller's selected tools. It does not silently switch to the caller's model.
Fresh runtime tokens require fresh approvals. Reload itself is queue-only; only
follow-up requests work. Concurrent reopeners join one initialization, and operation
protection covers the gap through input submission. `list_agents` omits unloaded
identities; `interrupt_agent` returns `not_found` for them without loading.

Validation precedes admission. Claiming unload is a commit point: later cancellation
can leave the victim unloaded, even if the new operation fails. Admission waits for
claimed teardown to finish before releasing its reservation. Failed/uncommitted
reopening leaves history recoverable and releases the claim; successful publication
is not rolled back if delivery later fails or the result is lost. The initiating
call owns reopen cancellation; joining callers cancel only their own wait. Accepted
native input is another commit point and is not retractable by later cancellation.
Follow-up checks execution capacity before accepting idle input, without double-start.
Root replacement/navigation/shutdown retire ownership and reject old captures;
runtime-only unload does not recursively retire descendants.

Recovery is in-memory for the current manager, not application-restart persistence.
The direct canned-provider regressions exercise pressure/unload/message/follow-up/
interrupt/follow-up, concurrent admission/reload, cancellation, failed reopen, stale
contexts, model/tool restrictions, approval reset and descendant routing. Live
provider timing/authentication remains a final-cutover smoke-test responsibility.

## Model selection (#363)

Fresh spawn follows the pinned `core/src/agent/child_config.rs:57-84,196-249`
ordering: invoking model/effort → explicit spawn fields (independently falling back
to configured subagent defaults) → applied role fields. Requested/default choices
are validated before a role may override them. Full-history forks without an
explicit role skip role model/effort application; fresh/recent forks and explicit
roles apply it. The three embedded roles currently specify neither model nor effort.
No model, including GPT-5.4, is hardcoded as the subagent default.

Configure `defaultModel` and `defaultReasoningEffort` in global
`~/.pi/agent/subagents.json` or project `.pi/subagents.json` (project fields win).
They correspond to Codex's `agents.default_subagent_model` and
`agents.default_subagent_reasoning_effort`. Settings load on session start/reload;
changing operational settings through `/agents` preserves manual project defaults
without copying inherited global values into the project. Existing children retain
their selected model/effort through follow-up and unload/reload.

Direct spawn accepts exact authenticated Pi `provider/modelId` identities or an
unambiguous exact model ID. Ambiguous bare IDs require provider qualification;
unknown/unavailable choices fail rather than fuzzy-matching, changing providers,
or falling back to the parent. Internal RPC/small-model fuzzy resolution is unchanged.
Existing optional scope policy remains: explicit out-of-scope choices fail;
configured/role/inherited choices warn and proceed. Reload still rechecks current
authorization and scope.

Reasoning overrides use Pi's levels and `getSupportedThinkingLevels`, not Codex's
provider-specific effort names/catalog. Unsupported explicit/configured efforts fail
before admission, including reasoning on a non-reasoning model. With a selected
model but no effort override, Codex resets to the catalog's model default. Pi has no
such metadata: our reset uses Pi's fresh-session per-model setting → global thinking
setting → `medium`, then Pi's capability clamp. Without either override, the parent
model/effort is inherited (`off` for non-reasoning models). A role-only model change
retains and validates the resolved effort, matching the pinned ordering.

The generated declaration now enables upstream inheritance guidance
(`hide_agent_type_model_reasoning=false`). At runtime each owning Pi extension
refreshes spawn's advertised model list on session start, model selection and before
a turn, using fresh contexts synchronously. Like Codex's `multi_agents_spec.rs:782-845`,
the list is capped at five; it does not limit exact lookup. Pi's authenticated
registry (restricted to session scope when enabled) supplies picker choices,
provider-qualified identities, names and supported/default efforts. Pi has no Codex
service-tier or backend-eligibility metadata; neither is invented or enforced.
The static generated artifact retains the empty-catalog placeholder, replaced by the
runtime list. Tool rendering remains a separate #363 task.

Regression evidence: direct-tool real-Pi/canned-provider tests cover exact selection,
configured defaults, effort reset/validation, provider-observed effort and retained
selection after unload/follow-up. The shared spawn execution check covers role
precedence and pre-role validation; settings tests cover merge/save/reset behavior.
No new live provider requests were made; earlier payload/token counts describe the
previous static descriptions, not this dynamic catalog.
