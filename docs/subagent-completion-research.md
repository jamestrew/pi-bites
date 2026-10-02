# Subagent completion and spawning guidance (Ref #379)

## Scope and conclusions

Initial research inspected Pi-bites source at parent commit
`b3674ec6`, with Pi SDK `0.99.1`. Upstream Codex source pins are listed below.

Follow-up implementation: `default-agents.ts` now uses the pinned
`CODEX_V2_CONTRACT.roles` descriptions for default, worker, and explorer. The
custom explorer child prompt was removed; all three roles inherit instructions
without adding role-specific prompts. Tools, permissions, and completion policy
are unchanged. References to custom local role text below describe the initial
pre-change audit, not the resulting implementation.

- The reported idle-parent behavior is intentional in the current implementation:
  completion becomes visible, persisted mail, but does not start inference.
- Official Codex V2 has the same ordinary queue-only policy. Durable sleep and V1
  must be considered separately; see the upstream investigation below.
- Pi-bites already supplies explicit-request-only spawning guidance. Its
  model-facing role schema still contains proactive encouragement, so there are
  competing signals. Prompt guidance is not runtime authorization enforcement.

## Pi-bites: completion end to end

1. `AgentManager.finishGeneration()` saves the result/status and settles the
   generation. Settlement releases execution capacity and calls
   `notifyComplete()`. Notifications are deduplicated per record/generation.
   Sources: [agent-manager.ts](../packages/ext/subagents/agent-manager.ts)
   lines 160–167, 404–426, 453–467.
2. `createAgentCompletionHandler()` snapshots the completed generation, emits
   `subagents:completed` or `subagents:failed`, and queues completion separately
   from UI cleanup. Stopped turns and retired conversations do not produce mail.
   Source: [agent-completion.ts](../packages/ext/subagents/agent-completion.ts)
   lines 1–65.
3. The composition root addresses the immediate parent's session and packages the
   child's canonical task name, final result/error, and completion status. Loaded
   sessions receive `messenger.queueOnly()`; unloaded child-parent identities
   retain mail until reload. Sources:
   [index.ts](../packages/ext/subagents/index.ts) lines 67–112, 194–207.
4. The messenger creates a displayed `subagent-message`, XML-escapes its
   model-facing content, and calls `pi.sendMessage(..., { triggerTurn: false })`.
   It marks unread activity and wakes existing mailbox waiters, not idle inference.
   Source: [subagent-messages.ts](../packages/ext/subagents/subagent-messages.ts)
   lines 16–28, 73–87, 112–142.

This is not a dropped result or a model choosing to ignore a new request:
**there is no new model request to act on it**. An idle parent sees the result on
a later externally initiated turn. A parent still running may see it at a later
Pi model boundary. A parent blocked in `wait_agent` is still inside an active
run; mail resolves the wait and becomes available for the next model call.

Completion is deliberately not a task: `task` defaults false and completion
does not set it. The `agent_before_settle` continuation hook considers only
`pendingTasks`, so ordinary messages/completions do not force continuation.
Sources: [subagent-messages.ts](../packages/ext/subagents/subagent-messages.ts)
lines 112–129, 168–175, 205–207;
[v2-tools.ts](../packages/ext/subagents/v2-tools.ts) lines 274–350.

`send_message` uses the same queue-only seam. `followup_task` separately calls
manager-owned turn-start/continuation logic and rejects `/root`. Thus a child
cannot wake an idle root by changing its explicit parent message to
`followup_task`. Source:
[v2-tools.ts](../packages/ext/subagents/v2-tools.ts) lines 178–244.

The V2 migration (`12e7bf6a`, Ref #364) deliberately removed the old completion
wake-up behavior. Its audit required queue-only completion and zero unsolicited
idle model requests:
[subagents-v2-audit.md](code-mode-contract/subagents-v2-audit.md), delivery
details and test recommendations. Treat this as a product-policy change if
automatic parent synthesis is now wanted, not a missing implementation of the
existing V2 contract.

## Installed Pi SDK: visibility is not execution

All SDK source references here are beneath
`node_modules/@earendil-works/pi-coding-agent/dist/core/`.

| Parent state / option                  | Actual SDK behavior                                                      |
| -------------------------------------- | ------------------------------------------------------------------------ |
| Idle; `triggerTurn` false or omitted   | Append/persist custom message and emit display events; no inference      |
| Idle; `triggerTurn: true`              | Start an agent run                                                       |
| Running; explicit `triggerTurn: false` | Defer history insertion until turn end; do not request continuation      |
| Running; omitted/true                  | Queue steering by default, or follow-up if selected                      |
| Any state; `deliverAs: "nextTurn"`     | Queue for a later prompt; this branch wins even over `triggerTurn: true` |

Sources: `agent-session.js:1714–1757`; next-prompt queue consumption:
`1533–1546`; busy context-only insertion: `764–771`.

Custom messages convert to user-role content for model context
(`messages.js:75–95`), independently of display events. The shared session
owns scheduling before provider selection
(`extensions/loader.js:290–297`; `agent-session.js:2634–2651`).
Using an OpenAI Codex model inside Pi does not install Codex CLI's scheduler.

Pi can therefore implement automatic completion continuation. The smallest
policy seam would be completion-specific delivery, preserving queue-only
`send_message`. A blanket change to `queueOnly()` would incorrectly wake
ordinary information recipients as well. No such change is made here.

## Pi-bites: existing discouragement and competing role text

The restriction is already present in
[v2-tools.ts](../packages/ext/subagents/v2-tools.ts), lines 69–76, as
`spawn_agent.promptGuidelines`. It requires explicit user/project/skill
authorization; depth/research requests alone do not qualify; role guidance is
not authorization. It also instructs bounded, nonduplicative delegation and
verification of delegated changes.

This is real prompt content, not just an unused property:

- [operations.ts](../packages/ext/subagents/operations.ts), lines 158–181,
  preserves the tool definition while wrapping execution.
- Installed SDK `agent-session.js:2748–2783` collects registered guidelines;
  `1209–1231` passes them with selected tools into prompt options.
- `system-prompt.js:56–58,85,110–114` includes selected tools' guidelines in
  `<rules>`. A `promptSnippet` is not required.
- Code Mode keeps these subagent operations direct:
  [activation.ts](../packages/ext/codex-adapter/activation.ts), lines 139–143;
  [index.ts](../packages/ext/index.ts), lines 50–69. Its prompt preview edits
  skill-loading wording, not the spawning restriction:
  [registration.ts](../packages/ext/codex-adapter/code-mode/registration.ts),
  lines 74–109.

Caveat: a Pi custom base prompt/custom rules or unrelated
`before_agent_start` full-text replacement can omit autogenerated guidelines.
Sources: installed SDK `system-prompt.js:76–85,106–114`;
`extensions/runner.js:1141–1143`; `agent-session.js:1284–1298`.
This audit did not inspect the user's external prompt configuration.

**The model-facing role description still pulls in the other direction.**
`spawn_agent.parameters.properties.agent_type.description` contains upstream
explorer text requiring explorers for scoped questions and encouraging multiple
parallel explorers. Worker text lists ordinary implementation/fix/refactor work.
Source: [subagents-v2-supported.json](code-mode-contract/subagents-v2-supported.json),
contract lines 298–308; used directly by
[v2-tools.ts](../packages/ext/subagents/v2-tools.ts), lines 72–84.

That role text is extracted from pinned upstream `agent/role.rs`, not from the
repo's narrower `DEFAULT_AGENTS` descriptions:
[generate-subagents-v2-contract.py](../scripts/generate-subagents-v2-contract.py),
lines 53–61, 87–90. Editing only
[default-agents.ts](../packages/ext/subagents/default-agents.ts)'s description
would not change the parent's advertised schema. The local explorer child
system prompt does say inherited restrictions take precedence (lines 52–56).

Inference, not a measured model result: this contradictory encouragement is a
plausible contributor to overly proactive use. Aligning the advertised role
text with the existing permission gate is more targeted than adding another
duplicate global warning. This remains prompt policy; the spawn execution path
validates arguments/capabilities but does not decide whether conversational
permission exists.

## Clarification: embedded role implementation versus advertised schema

`default-agents.ts` is the actual local runtime role configuration, not a Codex
copy. Its explorer adds a long child system prompt and excludes review, design,
and root-cause judgment. In both inspected upstream revisions, the built-in
explorer config is empty and default/worker have no config file; those builtins
add no role-specific child prompt or tool restrictions. The matching explorer
encouragement discussed above belongs to the **parent-facing tool schema**.
Sources: [upstream role configs](https://github.com/openai/codex/blob/cb6da58876afed3ede0ab11084f67dd5394ecb48/codex-rs/core/src/agent/role.rs#L345-L379),
[empty explorer config](https://github.com/openai/codex/blob/cb6da58876afed3ede0ab11084f67dd5394ecb48/codex-rs/core/assets/agent/builtins/explorer.toml),
[local role implementation](../packages/ext/subagents/default-agents.ts).

The four `builtinToolNames` are only the Pi-core starting inventory, not the
child's complete final tool surface:

1. `openAgentSession()` loads the role's embedded pi-bites extension, adds its
   registered tool names to those four builtins, and intersects the inventory
   with parent-derived `options.allowedTools`.
2. The extension registers Code Mode in child sessions too; the child model's
   adapter reconciles the selected tools into `exec`/`wait` and permitted nested
   capabilities such as `exec_command` and `apply_patch`.
3. Parent delegation permissions recover displaced Pi tools and nested
   capabilities, not just the root's visible declarations. The runner filters
   active child tools again after extension binding.

Sources: [agent-runner.ts](../packages/ext/subagents/agent-runner.ts), lines
355–405, 431–441, 467–485; [extension registration](../packages/ext/index.ts),
lines 44–72; [delegation projection](../packages/ext/codex-adapter/activation.ts),
lines 146–155; [adapter reconciliation](../packages/ext/codex-adapter/code-mode/registration.ts),
lines 33–72.

This is **permission-bounded reconstruction**, not literal inheritance of every
root tool implementation. Only the embedded role extension is loaded; arbitrary
root-only or third-party extension tools are not automatically copied. A child
using a non-Code-Mode model receives the corresponding Pi-core surface instead.
Upstream also inherits parent effective configuration, but configured role
overrides and V2 dynamic-tool inheritance settings affect the resulting child:
[child_config.rs](https://github.com/openai/codex/blob/cb6da58876afed3ede0ab11084f67dd5394ecb48/codex-rs/core/src/agent/child_config.rs#L62-L156),
[dynamic tools](https://github.com/openai/codex/blob/cb6da58876afed3ede0ab11084f67dd5394ecb48/codex-rs/core/src/agent/control/spawn.rs#L743-L773).

Follow-up verification: `bunx vitest run packages/ext/subagents/test/agent-capabilities-e2e.test.ts packages/ext/subagents/test/prompts.test.ts`
passed **2 files / 8 tests**. The real-child capability test covers Code Mode,
ordinary models, and inherited restrictions on editing/patching.

## Local verification

- `bunx vitest run packages/ext/subagents/test/subagent-messages-e2e.test.ts packages/ext/subagents/test/v2-messaging-e2e.test.ts packages/ext/subagents/test/v2-wait.test.ts`:
  **3 files / 34 tests passed**.
- The real-Pi idle test asserts zero provider requests after two completion
  messages, then asserts both appear exactly once after a new prompt:
  [subagent-messages-e2e.test.ts](../packages/ext/subagents/test/subagent-messages-e2e.test.ts),
  lines 326–350.
- Completion routing test verifies both generations use
  `{ triggerTurn: false }`:
  [v2-messaging-e2e.test.ts](../packages/ext/subagents/test/v2-messaging-e2e.test.ts),
  lines 255–271.
- Mailbox wait test verifies waiting does not consume messages:
  [v2-wait.test.ts](../packages/ext/subagents/test/v2-wait.test.ts), lines 11–29.
- `python3 scripts/generate-subagents-v2-contract.py ../codex --check`:
  **Subagent V2 contract verified**.
- `bun check`: lint, formatting, typecheck, and both test stages passed;
  **1,518 tests passed / 4 skipped** across 106 test-file runs.

## Official Codex source and verification scope

The existing V2 manifest pins OpenAI Codex to `1a89aec960cd92e2c59ce49b7f3c3347a915e4a9`; the local checkout at `/home/jt/projects/codex` is still at that clean revision. Research additionally verified official `origin` HEAD with `git ls-remote` and fetched **`cb6da58876afed3ede0ab11084f67dd5394ecb48`**. Its files were extracted to `/tmp/pi-bites-codex-379`, without changing the checkout's working files. Links below pin the newly verified revision. This is source inspection, not a Rust test run or verification of a particular installed Codex binary/server deployment.

## Codex: completion delivery does not normally restart an idle parent

### V2 terminal-turn path

1. A spawned V2 child's `TurnComplete` or `TurnAborted` event captures terminal status and calls the agent controller's `turn_finished`. This requires `ThreadSpawn` with a canonical agent path; internal review/other subagent sources do not take this path. [Terminal capture, `session/mod.rs:2333-2402`](https://github.com/openai/codex/blob/cb6da58876afed3ede0ab11084f67dd5394ecb48/codex-rs/core/src/session/mod.rs#L2333-L2402).
2. The controller formats the result for the **direct parent**, creates an `InterAgentCommunication` with **`trigger_turn: false`**, and sends it. Successful completion activity can separately be emitted to the turn that initiated the work, including a peer's follow-up. Activity and model-readable result delivery are distinct. [Routing and delivery, `agent/control/completion.rs:25-129`](https://github.com/openai/codex/blob/cb6da58876afed3ede0ab11084f67dd5394ecb48/codex-rs/core/src/agent/control/completion.rs#L25-L129).
3. Loaded-recipient submissions use `Op::InterAgentCommunication`; the session handler enqueues mail and invokes the idle scheduler only for trigger-turn mail or an outstanding durable sleep. **An ordinary idle parent therefore does not issue a new model request just because its child finishes.** [Session handler, `session/handlers.rs:78-95`](https://github.com/openai/codex/blob/cb6da58876afed3ede0ab11084f67dd5394ecb48/codex-rs/core/src/session/handlers.rs#L78-L95).
4. Starting a later parent task drains pending mailbox input; active turns drain mail only while their delivery phase permits it. Consequently a result can be consumed by the ongoing parent turn or by a later user-triggered turn. Accepted/queued mail is not proof that the parent model has read it. [Task start, `tasks/mod.rs:315-326`](https://github.com/openai/codex/blob/cb6da58876afed3ede0ab11084f67dd5394ecb48/codex-rs/core/src/tasks/mod.rs#L315-L326), [mailbox drain, `session/input_queue.rs:400-431`](https://github.com/openai/codex/blob/cb6da58876afed3ede0ab11084f67dd5394ecb48/codex-rs/core/src/session/input_queue.rs#L400-L431).

The result envelope is `Message Type: FINAL_ANSWER`, not a new task. Completed-without-text, errors, shutdown, and not-found have formatted results; ordinary interruption has none. Current source also handles Guardian's repeated-denial interruption separately. [Result formatting, `session_prefix.rs:20-46`](https://github.com/openai/codex/blob/cb6da58876afed3ede0ab11084f67dd5394ecb48/codex-rs/core/src/session_prefix.rs#L20-L46).

### Busy parent, answer boundary, and unloaded parent

- While sampling, mailbox mail can preempt at a completed output-item boundary unless `DeferMailboxPreemption` is enabled. This is not arbitrary token-level interruption. [`session/turn.rs:2804-2825`](https://github.com/openai/codex/blob/cb6da58876afed3ede0ab11084f67dd5394ecb48/codex-rs/core/src/session/turn.rs#L2804-L2825).
- Once mailbox delivery is deferred past the answer boundary, queue-only mail does not require another sample; it remains for the next turn. Turn-local leftover input is recorded during task finish. [`session/input_queue.rs:322-342`](https://github.com/openai/codex/blob/cb6da58876afed3ede0ab11084f67dd5394ecb48/codex-rs/core/src/session/input_queue.rs#L322-L342), [`tasks/mod.rs:661-686`](https://github.com/openai/codex/blob/cb6da58876afed3ede0ab11084f67dd5394ecb48/codex-rs/core/src/tasks/mod.rs#L661-L686).
- Current HEAD can retain non-triggering mail for a known **unloaded** recipient in controller-owned mailboxes without loading it. Loaded recipients retain submission ordering. This differs from the older source details in the repo's lifecycle note. [`agent/control.rs:254-310`](https://github.com/openai/codex/blob/cb6da58876afed3ede0ab11084f67dd5394ecb48/codex-rs/core/src/agent/control.rs#L254-L310).
- `wait_agent` subscribes to input-queue activity and returns an activity summary; it is called within an active model turn, not an independent idle-parent wake-up mechanism. [`multi_agents_v2/wait.rs:67-116`](https://github.com/openai/codex/blob/cb6da58876afed3ede0ab11084f67dd5394ecb48/codex-rs/core/src/tools/handlers/multi_agents_v2/wait.rs#L67-L116).

### Durable-sleep exception

Any mailbox mail, even queue-only completion mail, can restart an idle session with an outstanding durable `SleepItem`. Otherwise the pending-work scheduler requires `trigger_turn`. This is the exception referred to in the existing V2 audit; no `CompletionReport` wake-mode type was found in either inspected core revision. [`tasks/mod.rs:423-459`](https://github.com/openai/codex/blob/cb6da58876afed3ede0ab11084f67dd5394ecb48/codex-rs/core/src/tasks/mod.rs#L423-L459).

### Legacy V1 watcher

V2 spawn does **not** start the legacy completion watcher. V1 starts a detached watcher, waits for final child status, then injects `SubagentNotification` into the parent's context. For an active parent this queues input; for an idle parent it records history **without starting a turn**. Thus the ordinary no-idle-wake behavior is also present in this inspected V1 path, although its transport differs from V2. [`agent/control/spawn.rs:899-910`](https://github.com/openai/codex/blob/cb6da58876afed3ede0ab11084f67dd5394ecb48/codex-rs/core/src/agent/control/spawn.rs#L899-L910), [`agent/control.rs:450-558`](https://github.com/openai/codex/blob/cb6da58876afed3ede0ab11084f67dd5394ecb48/codex-rs/core/src/agent/control.rs#L450-L558), [`codex_thread.rs:796-801`](https://github.com/openai/codex/blob/cb6da58876afed3ede0ab11084f67dd5394ecb48/codex-rs/core/src/codex_thread.rs#L796-L801), [`session/inject.rs:169-187`](https://github.com/openai/codex/blob/cb6da58876afed3ede0ab11084f67dd5394ecb48/codex-rs/core/src/session/inject.rs#L169-L187).

These are core session/controller paths, not TUI-only behavior. The separate subagent activity item is an event notification; receiving/displaying that item does not itself schedule model inference. No frontend-specific auto-wake path was established in this bounded investigation.

### Existing upstream regression evidence (inspected, not executed)

- `subagent_notification_is_included_without_wait` explicitly submits another user turn and checks that V1's notification appears there. [`tests/suite/subagent_notifications.rs:959-986`](https://github.com/openai/codex/blob/cb6da58876afed3ede0ab11084f67dd5394ecb48/codex-rs/core/tests/suite/subagent_notifications.rs#L959-L986).
- `plaintext_multi_agent_v2_completion_sends_agent_message` lets the parent answer first, delays the child, and then starts/steers another user turn to receive `FINAL_ANSWER`. [`tests/suite/subagent_notifications.rs:2471-2645`](https://github.com/openai/codex/blob/cb6da58876afed3ede0ab11084f67dd5394ecb48/codex-rs/core/tests/suite/subagent_notifications.rs#L2471-L2645).
- `queue_only_mailbox_mail_waits_for_next_turn_after_answer_boundary` checks that late queue-only mail stays buffered rather than extending the answered turn. [`session/tests.rs:12646-12690`](https://github.com/openai/codex/blob/cb6da58876afed3ede0ab11084f67dd5394ecb48/codex-rs/core/src/session/tests.rs#L12646-L12690).

## Codex: discouragement is conditional prompt policy

### V2 developer-mode instructions

The bundled explicit-only policy supersedes earlier permission for proactive
delegation and requires an explicit user, project, or skill request for agents,
delegation, or parallel agent work.

Its proactive counterpart explicitly supersedes earlier developer instructions requiring an explicit request and encourages delegation when it could save time or improve quality. These are separate from the root/child role text that describes collaboration capabilities. [`prompts/src/model_messages/multi_agent.rs:7-47`](https://github.com/openai/codex/blob/cb6da58876afed3ede0ab11084f67dd5394ecb48/codex-rs/prompts/src/model_messages/multi_agent.rs#L7-L47).

Selection is the same in the repo's pinned `1a89aec…` revision and verified HEAD (`session/multi_agents.rs` is unchanged):

1. Only effective **V2** sessions select this mode.
2. Configured `multi_agent_v2.multi_agent_mode_hint_text` overrides model-catalog `multi_agent_messages.mode.hint_text`.
3. Without either hint, **effective reasoning effort `Ultra` selects proactive**; every other effort selects explicit-only. A catalog-provided explicit/proactive text overrides that selected bundled text.
4. Empty custom text suppresses this mode fragment.
5. Injection applies to ordinary root sources (`Cli`, `VSCode`, `Exec`, `Mcp`, `Custom`, `Unknown`) and spawned children (`ThreadSpawn`), but not internal sessions or other subagent sources.

Sources: [current selection, `session/multi_agents.rs:77-120`](https://github.com/openai/codex/blob/cb6da58876afed3ede0ab11084f67dd5394ecb48/codex-rs/core/src/session/multi_agents.rs#L77-L120), [pinned selection](https://github.com/openai/codex/blob/1a89aec960cd92e2c59ce49b7f3c3347a915e4a9/codex-rs/core/src/session/multi_agents.rs#L77-L120), [empty suppression and role, `context/multi_agent_mode_instructions.rs:13-51`](https://github.com/openai/codex/blob/cb6da58876afed3ede0ab11084f67dd5394ecb48/codex-rs/core/src/context/multi_agent_mode_instructions.rs#L13-L51).

The mode is emitted as a **developer-role `<multi_agent_mode>` contextual fragment**, not an invariant hard-coded system-role rule. World-state assembly adds the role hint and the selected mode as separate sections, reinjecting mode when its policy or role-hint hash changes. Default `multi_agent_mode_hint_text`, root/child hint overrides, and tool `usage_hint_text` are all `None`. [`session/world_state.rs:322-330`](https://github.com/openai/codex/blob/cb6da58876afed3ede0ab11084f67dd5394ecb48/codex-rs/core/src/session/world_state.rs#L322-L330), [`context/world_state/multi_agent_mode.rs:60-85`](https://github.com/openai/codex/blob/cb6da58876afed3ede0ab11084f67dd5394ecb48/codex-rs/core/src/context/world_state/multi_agent_mode.rs#L60-L85), [`config/mod.rs:1339-1378`](https://github.com/openai/codex/blob/cb6da58876afed3ede0ab11084f67dd5394ecb48/codex-rs/core/src/config/mod.rs#L1339-L1378).

### V1 tool-description restriction is longer

V1's fallback `spawn_agent` description additionally says that requests for depth, thoroughness, research, investigation, or detailed analysis are not permission, and role guidance helps choose an agent only after spawning is authorized. A configured tool `usage_hint_text` replaces that fallback. The V2 default tool description does **not** contain this full paragraph; it relies on the separate developer-mode mechanism and can append its own configured tool hint. [`multi_agents_spec.rs:720-745`](https://github.com/openai/codex/blob/cb6da58876afed3ede0ab11084f67dd5394ecb48/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L720-L745), [`multi_agents_spec.rs:793-820`](https://github.com/openai/codex/blob/cb6da58876afed3ede0ab11084f67dd5394ecb48/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L793-L820), [V1/V2 tool-hint callers, `spec_plan.rs:1335-1339,1420`](https://github.com/openai/codex/blob/cb6da58876afed3ede0ab11084f67dd5394ecb48/codex-rs/core/src/tools/spec_plan.rs#L1335-L1339).

This is model guidance, not a semantic tool gate proving that a human authorized delegation. The source inspected does not support treating explicit-only behavior as universal across reasoning efforts, custom hints, and catalog overrides.

### Historical names and remaining uncertainty

No `force_sub_agents_instructions` symbol was found in the inspected core/prompts trees, either pinned or current. The old `templates/collab/experimental_prompt.md` still exists and is permissive, but no current Rust source reference to that filename was found; it is not evidence of current V2 injection. No claims here establish what private model/server prompts add, or which policy a specific installed Codex release sends.
