# V2-only subagents: source audit and replacement plan

> Historical source/validation evidence. The V8 host and associated paths/commands
> are retired by #371; see [current native contracts](README.md).

## Decision and scope

#346 follow-through: the reproducible six-tool declaration/provenance layer is now
recorded in [CODEX_V2.md](../../packages/ext/subagents/CODEX_V2.md), including the
explicit wait-description correction. The original audit below remains historical
source evidence, not proof of runtime or live-provider compatibility.

User-selected direction, not yet implemented:

- Replace the V1 model-facing implementation with V2; do not maintain two versions.
- Register the same six ordinary Pi tools for every model/provider, including Anthropic.
- Keep those tools direct when Code Mode is active. No nested collaboration functions,
  subagent `ALL_TOOLS` entries, model-family switch, or `tool_search` implementation.
- Continue honoring extension disables, selected tools, inherited permissions, model
  scope, command approvals, and session ownership. “All models” is not permission
  to delegate or a reason to enable a tool excluded by the parent.
- Preserve Pi-native Fleet, navigation, auth, and provider transports. Borrow the
  supported V2 contract, not Codex's complete system prompt or backend.

This audit follows actual handlers and runtime behavior, not just descriptions. It
is source evidence and a plan, **not a claim of live V2 compatibility**.

## Baselines

- Codex checkout: `../codex`, clean at inspection, revision
  `1a89aec960cd92e2c59ce49b7f3c3347a915e4a9` (2026-09-26).
- pi-bites: `77889ee825b9043d5cacdf6d7c8b7b2e92f84c7f`.
- Pi dependency: `@earendil-works/pi-coding-agent` 0.87.1 (`package.json`).
- Current subagent contract pin remains `25af12f7e61572b0bc18ddb1008be543b91519b0`
  in `scripts/generate-subagents-contract.py:15`; this audit does not change it.

Upstream paths below are relative to `../codex/codex-rs/` and refer to the audited
revision. Local paths are relative to this repository.

Supporting factual investigations:

- [Pi feasibility](subagents-v2-pi-feasibility.md)
- [Upstream lifecycle and addressing](subagents-v2-upstream-lifecycle.md)

## 1. Model-facing contract

Default six-operation profile; omit optional upstream message-board, direct-message
suppression, and wait-disable variants. Use flat Pi names as the provider-neutral
transport adaptation. Upstream ordinarily uses the `collaboration` namespace where
supported, and its `non_code_mode_only` default is true.

| Tool              | Arguments / defaults                                                                              | Observable result and meaning                                                                                                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `spawn_agent`     | Required `task_name`, `message`; optional `fork_turns`, `agent_type`, `model`, `reasoning_effort` | Default hidden-metadata output is `{task_name: canonicalPath}`; not the V1 `{agent_id,nickname}`. Starts a task.                                                                            |
| `send_message`    | Required `target`, `message`                                                                      | Empty text on success; queue-only message. Does not start an ordinary idle agent turn.                                                                                                      |
| `followup_task`   | Required `target`, `message`                                                                      | Empty text on success; starts a turn if idle, otherwise delivers into ongoing work. Root target is rejected.                                                                                |
| `wait_agent`      | Optional integer `timeout_ms`; default 30,000, minimum 10,000, maximum 3,600,000                  | `{message, timed_out}`. Waits on the caller's mailbox/steered-input activity, not selected targets or agent statuses. Below-minimum values clamp with a notice; above-maximum values error. |
| `interrupt_agent` | Required `target`                                                                                 | `{previous_status}`. Interrupts a turn without closing the identity.                                                                                                                        |
| `list_agents`     | Optional `path_prefix`                                                                            | `{agents:[{agent_name,agent_status}]}` for visible live agents in the root tree. Not only currently running agents.                                                                         |

Sources: `core/src/tools/handlers/multi_agents_spec.rs:100-145,185-244,284-358,406-449,466-490,521-549,630-667,877`;
`core/src/config/mod.rs:254-258,1341-1360`;
`core/src/tools/handlers/multi_agents_v2/message_tool.rs:39-115`;
`core/src/tools/handlers/multi_agents_v2/wait.rs:48-63,155-182`.

### Description/implementation discrepancy

The upstream wait description says it summarizes _which agents_ have updates.
The handler does **not** return agent names. It returns one of:

- `Wait completed.`
- `Wait interrupted by new input.`
- `Wait timed out.`

plus a timeout-clamping explanation when applicable. Preserve the actual result
contract and record a minimal description correction rather than inventing a new
return field. Earlier conversational summaries claiming a list of updating agents
were too broad.

Source: `core/src/tools/handlers/multi_agents_v2/wait.rs:155-182`.

### Forking is a real behavioral change

`fork_turns` defaults to `all`; `none` starts fresh; a positive integer **string**
selects recent turns. Upstream counts real user instructions and trigger-turn
agent tasks, not every assistant/tool iteration or queue-only message
(`core/src/thread_rollout_truncation.rs:67-135,266-284`).
V1 defaults to no inherited conversation. Explicit role
selection is allowed even with a full-history fork in V2. Full forks without an
explicit role preserve inherited configuration; fresh/partial forks apply the
selected/default role.

Do not implement partial history as “last N messages”: tool-call/result pairs,
compaction, and the in-progress spawning turn require valid history construction.
Cross-provider history must go through Pi's normal conversion, not copied Codex
wire items. Full-history-by-default can increase child cost independently of eager
tool-definition tokens.

Sources: `core/src/tools/handlers/multi_agents_spec.rs:630-667`;
`core/src/tools/handlers/multi_agents_v2/spawn.rs:261-309`;
`core/src/agent/child_config.rs:49-99`.

## 2. Mailbox, tasks, and completion

The key invariant is **message receipt is not permission to start a new turn**.
Both messaging tools share dispatch; their meaningful difference is QueueOnly
versus TriggerTurn. Blank messages are rejected before dispatch. Queue-only
messages and follow-up tasks have attributed `MESSAGE` and `NEW_TASK` envelopes.
Completion has a `FINAL_ANSWER` envelope, routed to the structural parent.

Sources: `core/src/tools/handlers/multi_agents_v2/{send_message,followup_task,message_tool}.rs`;
`core/src/agent/control/delivery.rs:12-42`;
`core/src/context/{inter_agent_message,inter_agent_completion_message}.rs`;
`core/src/agent/control/completion.rs:25-129`.

Important details:

1. `send_message` must not be a renamed local `send_input`: local send-input can
   launch another turn. The same distinction applies to completion notifications
   arriving after the parent has finished.
2. `followup_task` targets an existing non-root agent. It is neither a new spawn nor
   unconditional abort-and-restart of active work. Concurrent submissions need one
   serialized per-agent turn-start decision.
3. Upstream wakes a wait on already pending mail as well as subsequent activity.
   Subscribing/checking pending state must not lose an arrival. Waiting does not
   consume the mailbox; delivery to model history is a separate action.
4. Completion notification is per terminal turn, not once per agent identity.
   Interrupted turns do not produce a final-answer notification. A later follow-up
   can complete and notify again. UI completion events and model notifications are
   distinct outputs.
5. Upstream can end sampling at completed reasoning/commentary items when mail is
   pending, unless `DeferMailboxPreemption` is enabled. Queue-only mail after a final
   visible answer may instead be deferred to the next turn. Pi must not promise
   token-level or mid-inference injection based on its ordinary steering queue.
6. Ordinary QueueOnly idle delivery does not wake a turn; upstream has a separate
   durable-sleep exception. Durable sleep is outside this six-tool migration.

Sources: local `packages/ext/subagents/register-send-input.ts:90-103`;
upstream `core/src/agent/control/api.rs:103-170`;
`core/src/session/input_queue.rs:115-152,249-275`;
`core/src/session/handlers.rs:79-94`;
`core/src/session/turn.rs:2725-2778`;
`core/src/session_prefix.rs:19-36`.

Proposed Pi adaptation: first reuse Pi's queue-only custom-message delivery and
existing subagent messenger. Add only the manager-owned activity/turn bookkeeping
needed to distinguish pending mail, delivered mail, and wake requests. Queue-only
sends must not call the idle-turn-start path; follow-ups may. Deliver at supported
Pi model/tool boundaries and describe that timing honestly. Keep UI metadata out of
the model payload. Persisted history is not by itself a pending mailbox, and an
in-memory queue must not be described as crash-durable. See the Pi feasibility
report for installed-source evidence and untested input-wakeup timing.

## 3. Lifecycle and addressing

The [upstream lifecycle evidence](subagents-v2-upstream-lifecycle.md) establishes:

- Paths are `/root/<task_name>` and nested descendants; names use lowercase ASCII,
  digits, and underscores. Name reservations are root-tree-owned; duplicate paths
  fail. Relative references append to the caller's path; `..` is not supported.
  Same task-name segment under different parents is valid.
- Messaging/follow-up can address siblings, not only owned children. The registry
  must contain sender and recipient. Follow-up rejects root; interrupt rejects root
  and self. Interrupt does not recursively stop descendants.
- Execution slots and resident runtimes are distinct. Completion releases execution
  capacity but leaves the runtime resident. At residency pressure Codex unloads an
  eligible least-recently-touched terminal runtime (completed/errored/interrupted,
  no active turn, no pending mail). Identity/path/history survive. No eligible
  resident means admission failure, not an invisible waiting queue.
- Default upstream capacity is **four including root**, hence three subagents.
  Local `maxConcurrent` is an existing child-capacity setting: preserve its meaning
  instead of silently subtracting one from users' configured values.
- `list_agents` includes loaded root and loaded agents, including terminal ones;
  **unloaded identities disappear from the list but remain addressable**. Do not
  mistake the list for the complete recoverable identity registry.
- Both queue-only sends and follow-up can reload a known unloaded identity. Reload
  precedes trigger-turn execution admission, so a failed follow-up can have already
  changed residency. Do not promise whole-operation atomic rollback.
- Upstream execution admission is advisory, not an atomic semaphore; preserve our
  reliable reservation/cost controls rather than reproducing an oversubscription
  race for alleged parity.
- Spawn commits after accepted initial input; cancellation after that commit can
  lose the result without undoing the child. It must remain discoverable/manageable.
  Uncommitted cleanup is asynchronous, not a synchronous transactional rollback.

Sources: `protocol/src/agent_path.rs:54-71,125-180`;
`core/src/agent/registry.rs:297-327,372-393`;
`core/src/agent/control/{api.rs:120-157,interrupt.rs:16-50,residency.rs:100-212,257-271,execution.rs:33-76,spawn.rs:630-677,770-887}`;
`core/src/agent/control.rs:348-418`; `core/src/config/mod.rs:254,1606-1618`.
See the supporting report for detailed reload/cancellation traces.

Removing public `close_agent`/`resume_agent` does **not** mean removing internal
cleanup/recovery. The old V1 rule that every completed open agent permanently
occupies a slot cannot remain behind a surface with no model-facing slot-release
operation.

Required design distinctions:

- Stable agent identity and canonical task path versus a currently loaded Pi session.
- Last task status versus admission/residency accounting.
- Interrupting a turn versus retiring an identity and its descendants.
- Internal unloading/reloading versus user-visible close/resume tools.
- Root-conversation authorization versus convenient path lookup.

Reuse retained conversations and existing internal interruption/close/reopen
machinery only where it preserves these distinctions. Do not alias interruption to
recursive close or call a completed agent deleted just because its Pi session is
unloaded. Paths must continue working across rehydration without inheriting stale
approval allowances. Failed admission must not reserve a name or slot indefinitely.

**Local teardown hazard:** `packages/ext/subagents/index.ts:144-165` closes
descendants on child `session_shutdown`, and `agent-manager.ts:126-137` wires close
to child cancellation. A V2 residency unload cannot simply call that whole path:
it would turn an internal memory-management action into descendant retirement.
Separate unload from conversation retirement while preserving cleanup on actual
root replacement/shutdown. Parent delivery and ownership must use stable identity,
not a transient Pi-session incarnation.

## 3a. Pi feasibility and remaining proof obligations

The [installed Pi evidence](subagents-v2-pi-feasibility.md) supports these conclusions:

| Concern                    | Finding                                                                                                                                              | Migration consequence                                                                                                                                                               |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Direct tools on all models | Existing controller calls ordinary `pi.registerTool`; child sessions are provider-neutral.                                                           | No second transport or provider implementation is needed. Test actual GPT and Anthropic payloads.                                                                                   |
| Queue-only delivery        | Pi `sendCustomMessage(..., {triggerTurn:false})` persists idle messages without prompting and safely delays active appends until tool results exist. | Reuse it. Current completion code explicitly uses `triggerTurn:true`; this must change.                                                                                             |
| Running delivery           | Pi steering is polled after a complete assistant response and its tool batch. Stream events are observational.                                       | Document next-supported-model-boundary timing; do not emulate Codex item preemption by blindly aborting inference.                                                                  |
| User input ending wait     | Ordinary Enter queues steering but does not abort the active wait tool. The `input` hook runs before queueing.                                       | Use a small session-owned activity latch if a regression probe verifies wake/queue ordering. Returning “interrupted by new input” must preserve that input. This is not proven yet. |
| Recent-turn forks          | Independent session entry import exists; runtime `fork()` replaces the parent instead of spawning a child.                                           | Reuse independent import, add a valid task-turn cutoff, test compaction/tool pairing and cross-provider conversion. Do not use replacement `fork()` for spawn.                      |
| Residency recovery         | Current retained entries and reopen preserve identity within a live manager; children are in-memory.                                                 | Add non-retiring unload/reload and stable ownership. Do not claim restart durability.                                                                                               |

Sources and exact installed-file lines are in the evidence report. Local completion
wake behavior is at `packages/ext/subagents/agent-completion.ts:131-141`; existing
selected-target wait is at `register-wait-agent.ts:85-107`. No runtime probe has yet
established input-hook wake ordering, partial-fork provider acceptance, or safe
residency unload. These are the first implementation checks, not reasons to build
custom providers or promise unavailable timing.

## 4. Exposure: mostly deletion

Current direct tool registration already exists for ordinary Pi routes. The extra
V1 adapter connection is for nesting, not a prerequisite for managing agents.
Replace the operation set in `packages/ext/subagents/operations.ts`; preserve its
caller/permission validation and session-generation cancellation rather than
creating another execution layer.

Remove live V1 collaboration integration from:

- `packages/ext/codex-adapter/activation.ts:54-59,125-142,163`: subagent displacement,
  native-prefix projection, and reverse mapping specific to V1.
- `packages/ext/codex-adapter/code-mode/registration.ts:33-61`: owned controller and
  nested subagent availability plumbing.
- `packages/ext/codex-adapter/code-mode/nested-adapters.ts:147-180`,
  `nested-tools.ts:17,62-65,154,199`: subagent capture/dispatch/result adaptation.
- `packages/ext/codex-adapter/code-mode/contracts.ts:1,34-36,45,68-74`: V1 metadata
  and namespace-wide discovery instructions. Do not replace these with V2 discovery.
- V1 nested renderer registration and nested-only integration scenarios.
- `packages/ext/index.ts:70`: adapter's subagent-controller argument.

**Keep** core-tool permission recovery (`getAllowedTools` / `getDelegationTools`):
children still need permissions corresponding to the parent's underlying shell/file
capabilities when the parent uses Code Mode. Removing subagent nesting does not
justify removing that authorization translation.

Keep historical display support if needed to render saved V1 sessions; old tool
results are not live V1 executors. Never auto-replay saved tool calls or adopt stale
saved agents on reload. Shared UI/text/usage helpers also have non-subagent callers.

## 5. Local policy and necessary deviations

Already decided:

- All Pi models use the same V2 surface; no upstream model-version selection logic.
- Flat direct tool names; no provider-specific namespace requirement.
- Pi model registry/authentication and reasoning capabilities remain authoritative.
- No Responses-only encrypted communication, Codex sandbox/backend infrastructure,
  wholesale model-system-prompt import, or `tool_search`.

Proposed conservative choices, to record explicitly rather than call upstream parity:

- Preserve configured delegation-depth and cost controls until a deliberate change
  is requested; do not silently weaken an existing user/project restriction.
- Keep the three existing roles and additive Pi/project/skill prompts. Allow V2
  full-fork role overrides without granting tools forbidden by the parent.
- Translate inter-agent content through stock Pi message conversion. Do not fake
  model-generated assistant turns merely to reproduce upstream's content role.
- Retain human UI stop/cleanup controls even though model tools no longer expose
  close/resume. Their effects must be distinguishable from `interrupt_agent`.
- Keep normal reload/shutdown invalidation; runtime persistence across process
  restarts needs an explicit implementation and tests, not an inference from saved UI.

## 6. Replacement sequence and acceptance checks

Keep the new surface inaccessible until execution, lifecycle, and presentation are
coherent; switch once, not through a publicly mixed V1/V2 interface.

1. **Pin the supported six-tool contract.** Replace the V1 contract extraction,
   names, schemas, provenance, and supported-description deviations. Do not upgrade
   the unrelated Code Mode host just to expose ordinary Pi tools.
2. **Implement identity/residency and mailbox behavior inside subagents.** Retain
   stable dependency snapshots, current permission rechecks, per-agent sequencing,
   approval cancellation, and owner generations. Prefer existing manager/runner
   seams over a second agent framework.
3. **Register six direct tools and cut out nested/V1 exposure.** Update child
   guidance, configuration docs, contract docs, ADR amendments, smoke scripts, and
   prompt/token measurements together. Internal close/reopen remains if needed.
4. **Validate behavior, then remove obsolete live V1 machinery.** Do not preserve
   a V1 compatibility mode or duplicate direct/nested behavioral suites.

Minimum behavioral acceptance scenarios:

- Spawn/fork (`all`, `none`, recent turns), invalid names/arguments, role overrides,
  same-name races, canonical and relative addressing, cross-root rejection.
- Idle queue-only message and idle completion: zero unsolicited model requests;
  follow-up later sees queued content exactly once.
- Running message/follow-up delivery around pending tools, final answer, compaction,
  and errors; no concurrent double-start; completion on each later terminal turn.
- Wait with mail already pending, mail arriving during subscription, steered user
  input, timeout/clamping, cancellation, and session replacement. Wait must not
  consume mail or synthesize the old V1 final-status result.
- Fill capacity, complete work, spawn more, rehydrate a completed agent for follow-up,
  interrupt it, and follow up again; no identity loss, leaked reservations, silent
  queue, or duplicated turn. Preserve restrictions across unload/reload.
- Root/sibling/descendant permissions; stale approvals cannot execute commands after
  interruption or invalidation. Use throwing-getter contexts in regression checks.
- GPT with Code Mode, GPT with adapter disabled, and Anthropic: same six direct tool
  names; no nested collaboration entries or V1 controls; selected-tool disables and
  child model switching still work. Verify actual provider payloads, not only lists.
- Fleet/navigation, usage and session-tracker events, restored historical display,
  error presentation, per-command bash-gate and Auto Mode/human escalation.

Run focused manager/mailbox/history/approval/renderer tests and final `bun check`.
Use live GPT and Anthropic smoke routes for timing and payload assumptions; record
unavailable credentials/routes rather than treating simulated checks as live proof.
No live provider requests or native Codex runtime tests were made for this audit.
