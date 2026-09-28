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

Generation followed by `--check` verifies reproducibility against all pinned source
hashes and generated declarations. This is source/contract evidence, **not** a native
Codex execution test or live provider compatibility claim. Runtime behavior and
provider payloads require the implementation's behavioral tests and smoke routes;
unavailable routes must remain explicitly unverified. No host pin change is needed.

## Staged integration (#346)

`v2-integration-harness.ts` is an explicit test entrypoint, not imported by ordinary
extension activation and not enabled by configuration. It registers executable
`spawn_agent`, `list_agents`, `send_message`, `followup_task`, and `wait_agent`; interrupt
remains provenance, not a stub executor. The existing controller, manager, Fleet/navigation, approvals, runner,
provider registry and selected-tool intersection remain authoritative. The V1 Code
Mode bridge declines this direct-only controller, including in child sessions.
Ordinary sessions retain their existing surface until the coherent six-tool cutover.

Full history is the default; `none` is fresh. Empty/whitespace fork selection means
`all`, and the two keywords are case-insensitive. Recent-turn selection explicitly
fails in this slice rather than silently copying everything. Pi imports the active
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
a settled runtime unloads. Terminal named tasks release execution capacity; automatic
residency-pressure admission and reload policy belong to later slices.

The tests exercise direct tools, shared operations and real Pi sessions with a canned
provider, including full/fresh imports, additive policy, selected tools, Code Mode
coexistence and Pi's shared Anthropic/OpenAI history transformer. Live provider
requests are not performed; provider-authentication and live timing smoke routes
remain for the final cutover. Existing source-audit reports describe the inspected
baseline, not a claim that later mailbox/residency slices are already implemented.

## Loaded-agent messaging (#347)

Direct messaging validates text and root-tree membership before native delivery.
Relative paths resolve beneath the caller; canonical paths permit parent and sibling
communication. Sender task paths and message text are attributed in model content;
activity IDs and interaction status remain display/bookkeeping metadata. Both tools
return empty text, without V1 submission receipts. Unloaded agents fail explicitly;
rehydration belongs to the residency slice.

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
Because Pi has no public session-level context-only idle continuation, this adds a
neutral user instruction, `Continue with the queued follow-up task.`, while the
attributed task content appears once. The manager also drains work accepted in the
gap between native settlement and manager completion. Admission and delivery have
no intervening await; concurrent calls cannot double-start. Idle follow-up at full
execution capacity fails before delivery rather than creating an invisible queue.

Native acceptance is the commit point: later caller cancellation does not retract
accepted input. Invalidated captures cannot deliver or start work; disposed messenger
endpoints do not touch invalidated extension APIs. Fleet retains idle rows with
pending messages, and direct result metadata updates the call row without adding
model-visible acknowledgments. The staged tests use real Pi and a canned provider;
live GPT/Anthropic timing and residency/recovery remain unverified here.

## Completion mail and mailbox waits (#348)

The staged V2 completion path queues attributed final answers through the same
native queue-only messenger as information messages. Each completed generation
delivers once, including later follow-up turns; stopped/interrupted turns do not
send finals. Failures queue attributed failure text. Fleet/status/usage events
remain separate from model content; completion metadata styles the single incoming
message instead of adding a second result notification. Idle completion never
requests a parent model turn. Ordinary V1 activation remains unchanged.

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
