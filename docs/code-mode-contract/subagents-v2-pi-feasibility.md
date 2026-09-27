# Pi feasibility evidence for direct V2 subagent tools

## Scope and evidence

This is a source audit of the installed Pi **0.87.1** runtime and current pi-bites
subagents, not an upstream Codex audit or an implementation proposal. “Supported”
below means an API/control-flow fact, not a live-provider acceptance test. The
comparison requirements supplied by the parent are: queue-only delivery must not
wake an idle parent; a pending mailbox wakes a wait without consuming messages;
wait returns only `message` and `timed_out`; upstream can preempt at
reasoning/commentary item completion and defers queue-only input after final output.
Those upstream facts were not independently verified here.

Source path abbreviations (all line numbers refer to these exact installed files):

- **B** = `/home/jt/projects/pi-bites/packages/ext/subagents/`
- **P** = `/home/jt/projects/pi-bites/node_modules/@earendil-works/pi-coding-agent/dist/`
- **A** = `/home/jt/projects/pi-bites/node_modules/@earendil-works/pi-agent-core/dist/`
- **D** = `/nix/store/ai9szyf9fivph9rdk65gzjiy30sll754-pi-0.87.1/libexec/pi/docs/`

Complete relevant documentation read: `D/sdk.md`, `extensions.md`,
`session-format.md`, `sessions.md`, `message-types.md`, `how-pi-works.md`,
`compaction.md`, `settings.md`, `keybindings.md`, `configuration.md`, and `models.md`.
Relevant linked examples read: the same Pi installation's
`examples/sdk/11-sessions.ts` and `13-session-runtime.ts`. Executable installed JS
and its public declarations supply the precise implementation citations below;
this avoids assuming another Pi checkout matches the installed version.

## Confirmed Pi capabilities and limits

### Message delivery and turn scheduling

| Requirement                                | Pi fact                                                                                                                                                                                                                   | Exact evidence                                                                                                                                                 |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deliver while idle without starting a turn | `sendCustomMessage(message, { triggerTurn: false })` appends a custom entry, refreshes finalized context, and emits message events; it does not prompt. Extension `pi.sendMessage` exposes these options.                 | `P/core/agent-session.js:1467-1524`; `P/core/extensions/types.d.ts:1046-1050`                                                                                  |
| Queue-only while active                    | The same explicit `triggerTurn:false` defers the append until the current turn's tool results are present. It does not enter the agent steering queue.                                                                    | `P/core/agent-session.js:1509-1539`                                                                                                                            |
| Active steering                            | `steer()` queues user input. The loop polls steering at startup and after a complete assistant response **and its entire tool batch**, not between sibling tool executions.                                               | `P/core/agent-session.js:1406-1443`; `A/agent-loop.js:79-207`                                                                                                  |
| Follow-up                                  | `followUp()` queues; the loop consumes follow-ups only after tool work and steering stop requiring requests. An idle custom message with `triggerTurn:true` starts a run. `steer()`/`followUp()` themselves only enqueue. | `P/core/agent-session.js:1418-1455,1481-1510`; `A/agent-loop.js:192-218`                                                                                       |
| Next-turn-only delivery                    | `deliverAs:"nextTurn"` pushes to a separate pending queue before all other options. It is not equivalent to appending a visible/context entry immediately while idle.                                                     | `P/core/agent-session.js:1492-1494`                                                                                                                            |
| Completed run                              | `agent_end` can precede recovery/retries or queued work. `agent_settled` is notification-only; `agent_before_settle` and `turn_end` support entries and a continuation decision.                                          | `D/sdk.md`, “Subscribing to events”; `D/extensions.md`, “Respect the runtime lifecycle” and “Events and concurrency”; `P/core/extensions/types.d.ts:1000-1007` |

**Existing native reuse:** queue-only persistence/delivery is already implemented
by `sendCustomMessage(..., {triggerTurn:false})`; no replacement message-storage
or delivery engine is needed to obtain that behavior. Persisted history is not
the same thing as a pending mailbox. Any extension-owned activity/sequence state
would address the separate wake/unread predicate, not duplicate native delivery.

`triggerTurn:false` prevents a new request caused by that message; it does not hide
it from a next request already required by tool results. Conversely, omitting
`triggerTurn` while streaming queues custom messages as steering, so omission and
explicit false are materially different (`P/core/agent-session.js:1495-1514`).

**Item-level preemption is not supplied by the steering scheduler.** Pi emits
`message_update` for `text_end`, `thinking_end`, and tool-call stream events
(`A/agent-loop.js:278-303`). Its extension event is observational and has no
preemption return type (`P/core/extensions/types.d.ts:663-667,1007`). The stream
continues until `done`/`error`, then the loop executes tools and polls steering
(`A/agent-loop.js:304-329,153-193`). `ctx.abort()` exists, but it aborts the active
operation rather than expressing “deliver mailbox and continue this item safely”
(`P/core/extensions/runner.js:601-604`; `P/core/agent-session.js:1608-1618`).
Whether an abort-and-restart emulation can preserve provider-specific partial
reasoning and tools is **untested**, not an established equivalent.

### Wait interruption and mailbox visibility

- Ordinary interactive submission while streaming calls
  `session.prompt(text, { streamingBehavior:"steer" })`; it does **not** abort an
  executing tool (`P/modes/interactive/interactive-mode.js:2615-2624`). The prompt
  queues input (`P/core/agent-session.js:1242-1257`), and the tool batch must finish
  before steering is polled (`A/agent-loop.js:158-193`). Thus a long-running wait
  tool does **not natively wake just because the user presses Enter**.
- A tool receives the operation's `AbortSignal`
  (`A/agent-loop.js:543-550`). `session.abort()` cancels the agent and then waits
  for idle, whereas `waitForIdle()` alone is only an idle promise
  (`P/core/agent-session.js:1608-1625`). This is whole-operation cancellation,
  not an input-triggered successful wait result.
- Pi has an `input` hook with `source` (`interactive`, `rpc`, `extension`) and
  streaming behavior; it runs before queueing and can continue, transform, or
  handle input (`P/core/extensions/types.d.ts:720-743`;
  `P/core/agent-session.js:1166-1178,1230-1257`). This is an available observation
  point for an extension-owned waiter. There is no built-in “wait interrupted by
  new input” result in these APIs. Queueing order versus resolving a waiter from
  the hook remains **untested**. Slash extension commands execute before this
  input hook, and TUI input during compaction is separately queued
  (`P/core/agent-session.js:1216-1224`;
  `P/modes/interactive/interactive-mode.js:2603-2614`).
- `pendingMessageCount` and the user steering/follow-up accessors count only the
  corresponding text queues (`P/core/agent-session.js:1590-1601`); custom messages
  use separate agent/pending-custom paths (`1481-1539`). These accessors are not
  a complete collaboration-mailbox predicate.

### Partial history forks

Pi can instantiate an independent in-memory session from supplied entries:
`SessionManager.inMemory(cwd, options, entries)`
(`P/core/session-manager.js:1363-1366`). It also has entry-addressed branching:
`createBranchedSession(leafId)` walks the branch to that entry, rechains removed
labels, and adjusts compaction references (`1201-1232`).

`AgentSessionRuntime.fork(id, {position:"at"})` accepts any existing entry and
includes it; default `position:"before"` requires a user-message entry and
excludes it (`P/core/agent-session-runtime.js:174-194`). **This runtime method
replaces the active parent session**; it does not spawn an independent child
(`195-248`). The independent entry-import primitive above is distinct.

Current pi-bites only exposes the boolean `fork_context`, snapshots
`buildContextEntries()` and imports those entries
(`B/operations.ts:55-60,90-91,163-184`; `B/agent-manager.ts:310-313`;
`B/agent-runner.ts:419-431`). This is the currently selected, compaction-aware
context, **not every raw historical branch**. Pi's context builder selects the
latest compaction and retained range (`P/core/session-manager.js:201-257`).
There is no current subagent argument for a partial-entry cutoff.

Entry-based cuts are supported; arbitrary mid-message/reasoning-item cuts are not
an API exposed by these methods. Correct replay when a cutoff splits an assistant
tool-call batch, crosses context edits/compaction, or changes provider is
**untested here**. Successful entry import alone does not establish provider-valid
conversation structure. Pi explicitly defers active custom appends to avoid
splitting calls and results (`P/core/agent-session.js:1510-1514`).

### Unload, rehydrate, and ephemeral contexts

Pi runtime replacement aborts and settles the outgoing session, emits
`session_shutdown`, disposes it, constructs the replacement, rebinds, and then
passes a fresh context to `withSession`
(`P/core/agent-session-runtime.js:101-127,174-248`). `session.dispose()` alone
aborts resources and invalidates contexts but does **not** emit `session_shutdown`
(`P/core/agent-session.js:822-841`). The existing child shutdown helper explicitly
emits it once before disposal (`B/agent-session-shutdown.ts:6-34`).

Context properties including UI, cwd, session manager, model registry, model,
scoped models, and signal have throwing stale-instance guards; context methods
are guarded too (`P/core/extensions/runner.js:441-451,547-624`). Command contexts
preserve those getters via property descriptors (`627-664`). Snapshotting plain
data or stable owned dependencies before an await is not optional. A captured
`pi` runtime is also invalidated; keeping its object identity is not proof it can
be called after replacement (`441-445`).

Current child conversations are in-memory (`B/agent-runner.ts:419-431`). Close
retains an owned active-branch conversation in manager memory, strips plain
`custom` extension-state entries, rechains parent IDs, and repairs compaction
boundaries (`B/agent-close.ts:133-188`). Reopen validates ownership, linear entry
links, header/cwd, and compaction references, selects a currently authorized
model/tool loadout, and creates a new session without prompting
(`B/agent-reopen.ts:63-205`). It assigns a fresh incarnation while retaining the
agent ID. This is a **close/reopen capability within the live manager**, not
process-persistent recovery: shutdown clears active agents and closed records
(`B/agent-manager.ts:954-990`; `B/agent-close.ts:54-56`). Pi supports persistent
session storage, but current subagents do not persist the registry/tombstones
needed to recover these owned identities after extension reload or process exit.

**Teardown is currently coupled to descendant retirement.** Every child
`session_shutdown` invalidates its controller, flushes/disposes its messenger,
removes delivery/controller registrations, then calls `retireDescendants()`.
That helper marks descendants retired and calls `manager.close()` on them
(`B/index.ts:144-165`). There is no shutdown-reason branch in this handler.
Consequently, the existing `shutdownAgentSession()` path is not a transparent
resident-only unload: it triggers descendant closure even if the caller merely
wanted to release that session's runtime resources.

The installed public `AgentSession` declaration contains `dispose()` but no
`suspend` or `unload` method (`P/core/agent-session.d.ts:312`; declaration searched
for all three names). Direct `dispose()` skips extension shutdown emission, as
noted above; that fact is **not** proof it safely replaces orderly child teardown:
it also skips the extension-owned cleanup performed by the existing helper.
Separating logical agent lifetime from runtime residency is not a built-in
suspend/resume facility shown by these APIs. No suspend/unload runtime experiment
was performed.

## Existing seams: reusable behavior and observed deltas

| Area                                    | Existing implementation                                                                                                                                                                                                                            | Difference from the supplied V2 requirements                                                                                                                                                                                      |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Direct, model-independent tools         | `SubagentController.registerTools()` calls ordinary `pi.registerTool`; no model predicate in registration. Calls share ownership, selected-capability, argument, lifetime-signal, and ancestor-close guards (`B/operations.ts:48-139,152-186`).    | Existing definitions/names/arguments and help are V1, including the child Code Mode parent-message instruction (`152-161,194-195`). All-model direct registration is available; exact V2 behavior is not implied by registration. |
| Child execution                         | Provider/model-neutral SDK sessions, cloned registered providers, authorized tool filtering, retained turns (`B/agent-runner.ts:403-507,572,667`).                                                                                                 | Current session engine can be retained independently of exposure; no all-provider V2 smoke was performed.                                                                                                                         |
| Child input                             | Active children steer; settled children start another turn; queued input is buffered (`B/agent-manager.ts:668-735`). Parent delivery is separately routed (`B/register-send-input.ts:55-102`).                                                     | No distinct queue-only inbox for all target states in this path; ordinary settled-child input starts work.                                                                                                                        |
| Parent intermediate messages            | Session-addressed messenger persists idle without a turn, drains active input at `turn_end`, and defers after terminal output (`B/subagent-messages.ts:39-219`).                                                                                   | Final-output deferral is already modeled locally, but item-level preemption and a waiter-visible mailbox are absent from that state machine.                                                                                      |
| Completion                              | Generation snapshots, explicit selected-target waits, automatic delivery, and UI cleanup are separated (`B/agent-completion.ts:85-233`).                                                                                                           | Automatic completion uses `{deliverAs:"steer", triggerTurn:true}` (`131-141`): idle parents wake, unlike supplied QueueOnly semantics.                                                                                            |
| Wait                                    | Completion, timeout, disposal, or abort resolve waiter records; timeout/abort remove waiter listeners and do not close agents (`B/agent-completion.ts:211-303`).                                                                                   | It observes selected agent terminal status, not unread mailbox/new-input state; model result is `{status,timed_out}`, cancellation throws (`B/register-wait-agent.ts:85-107`). Not the supplied V2 message-only result.           |
| Parent lifecycle and delivery ownership | Per-session delivery map and per-child controller, shutdown flush, descendant retirement on child replacement/tree changes (`B/index.ts:69-175,472-493,545-557`).                                                                                  | Registry recovery across runtime unload is not persisted.                                                                                                                                                                         |
| Stale-context protections               | Controller capture snapshots entries only when requested, records owner epoch, and combines abort signals (`B/operation-context.ts:35-75`; `B/operations.ts:48-76`); parent runner dependencies are plain snapshots (`B/parent-snapshot.ts:6-35`). | Any deferred mailbox/wait path would need the same ownership constraints; no V2 path exists to verify yet.                                                                                                                        |

Existing regressions explicitly model throwing context getters in
`B/test/operations.test.ts:101-131`,
`B/test/agent-manager-lifecycle.test.ts:23-47,76-170`, and
`B/test/agent-manager-reopen.test.ts:220-232`. These establish that the repository
already has the relevant test technique, not that prospective V2 code is covered.

## Remaining untested questions

1. Input-hook wake ordering: successful wait interruption must preserve the user's
   queued input and must not consume pending collaboration messages. No runtime
   probe of that scheduling race was performed.
2. Cross-provider item-preemption equivalence: exposed stream item events do not
   establish safe continuation after abort, and do not provide Codex's named
   reasoning/commentary preemption policy.
3. Partial-fork replay: cuts through pending tools, context edits, compaction,
   system/tool declaration changes, and cross-provider reasoning signatures were
   inspected structurally but not exercised against providers.
4. Runtime-unload recovery: Pi can reconstruct session entries, but restoration
   of agent ownership, mailbox state, waiters, model permissions, and incarnation
   boundaries is not implemented by the existing in-memory tombstones.
5. “All models” here means no model-specific restriction in Pi's ordinary custom
   tool registration/session APIs. It is not proof every configured endpoint
   supports the eventual schema, historical message encoding, or tool calling.

No implementation files were edited and no provider requests were made. Validation
of the combined documentation change, including repository-required `bun check`,
is owned by the parent session because that command formats the shared tree.
