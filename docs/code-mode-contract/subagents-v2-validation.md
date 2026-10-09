# V2 release validation (#353)

## Integration status

This validates the V2-only integration based on `dee4827f` on
`codex-subagents-v2`, not a release to `master`. The PR carrying this record is the
integration candidate; its eventual rebase/merge reference is assigned by the runner.
No merge or parent-epic closure is claimed here.

**Release validation remains incomplete.** GPT Code Mode and adapter-disabled live
smokes pass. Anthropic has no configured authenticated route. Maintainer disposition
of that gap and the remaining live scenarios below is **pending**, not implicitly
waived by accepting this evidence PR. Do not treat a green offline suite or this
PR's merge as certification of those routes. The parent epic remains untouched.

## Contract and configuration

The [V2 contract](../../packages/ext/subagents/CODEX_V2.md),
[source manifest](subagents-v2-source-manifest.json), supported declaration/edit
record, upstream lifecycle audit and Pi feasibility audit are published alongside
this record. Regeneration against Codex `1a89aec960cd92e2c59ce49b7f3c3347a915e4a9`
passes. Pi remains 0.87.1; the unrelated Code Mode host stays at its existing pin.
The [ADR amendment](../adr/0001-codex-code-mode-scope.md#direct-v2-collaboration-352)
is authoritative over the explicitly historical V1 material.

Ordinary activation exposes six direct tools without a V1 selector, nested
collaboration, discovery prerequisite, custom provider or host upgrade. Extension
`disable` entries belong in `.pi/pi-bites.json` (or the global configuration);
`subagents` and `codexAdapter` remain independently disableable after reload.
Operational settings belong in `.pi/subagents.json`, overriding
`~/.pi/agent/subagents.json`, or use `/agents` → Settings. `maxConcurrent` defaults
to six **children**, separately bounding execution and resident runtimes, not total
threads including root. Nesting is uncapped by default (#384); explicit `maxDepth`
is opt-in local policy, not upstream V2 parity (`0` disables spawn, `1` permits only
root children). Project values override global values; removing the effective setting
restores uncapped nesting on the next settings load. `scopeModels` and `fleetView`
retain their existing meaning. Selected tools, model scope and additive delegation
policies still apply.

Material adaptations remain explicit: flat Pi tool names; supported model/tool
permissions rather than Codex infrastructure; Pi tool-batch delivery boundaries;
queue-only completion; generic mailbox wait results rather than updating-agent
lists; bounded pending-input polling; recent forks from surviving task boundaries;
in-memory retained identities rather than application-restart recovery; and strict
local child-capacity admission. Full/fresh/recent history and approval incarnation
rules are described in the contract, not inferred from native prose.

The #384 nesting change is verified offline by `v2-nesting-e2e.test.ts`,
`v2-operations.test.ts`, `task-paths.test.ts`, `settings.test.ts` and existing nested
messaging/residency/interrupt/close/reopen checks without depth overrides. It retains
shared budgets, tool ceilings and live-owner checks. No new live provider requests
are made for this change; the live evidence below predates it.

## Live stock-provider evidence

[Machine-readable results](smoke/subagents-v2-results.json) retain successful direct
operation transcripts, queued mail, lifecycle events, checks, first parent/child
payload measurements, per-request SHA-256 hashes and provider-reported usage. Raw
synthetic captures are local to the listed `/tmp/353-*` directories and are not
permanent repository artifacts. Re-run the commands below to collect new captures;
request IDs, timestamps, paths, model output and usage naturally vary.

| Route                                 | Result      | Evidence boundary                                                                        |
| ------------------------------------- | ----------- | ---------------------------------------------------------------------------------------- |
| `openai-codex/gpt-5.6-sol`, Code Mode | Pass        | 13 requests, parent and child, grammar `exec` plus six direct collaboration tools        |
| Same model, adapter disabled          | Pass        | 13 requests, parent and child, core tools plus six direct collaboration tools            |
| `openai-codex/gpt-5.6` (both modes)   | Unavailable | Initial catalog probe; the unsuffixed model is not an available route                    |
| `anthropic/claude-sonnet-4-5`         | Unavailable | No configured authenticated Anthropic route; no inference or provider acceptance claimed |

The stock availability check also finds named GPT-5.6/GPT-6 variants, GPT-5.5 and
GPT-5.3-codex-spark; it finds no available direct OpenAI or Anthropic models. Catalog
availability is not successful inference. Only the two successful routes above are
certified for this smoke's narrow lifecycle, not all listed variants.

Both successful runs execute named `spawn_agent` with an explicit same-model default
child and `fork_turns: "none"`, one exact-command approval, child-to-parent
`send_message`, mailbox `wait_agent`, `list_agents` completion, settled-task
`interrupt_agent`, and `followup_task` recall without repeating the retained marker.
Parent history contains one progress message and exactly two completion messages.
All captured parent/child tool definitions contain the six direct names, without V1
controls, nested collaboration, `tool_search` or collaboration discovery guidance.
The scripted UI approves only `printf subagent-approved`; this is the production
approval broker with a controlled UI, **not** a human terminal or live Auto Mode test.
No user conversation or repository source is sent.

The initial Sol runs fail evidence checks despite completing the lifecycle. The
harness puts canonical `/root/probe` in a filename, causing child payload capture to
throw, and expects queue-only mail in streaming `message_end` events. The corrections
use sequence-only filenames (owner remains metadata) and inspect native parent
history for mail, requiring exactly two finals rather than accepting duplicates.
Those failed trials remain failed in the record. Corrected runs pass both modes;
no production session/provider workaround is introduced.

```sh
bun scripts/subagents-route-smoke.ts openai-codex/gpt-5.6 /tmp/353-smoke-gpt
bun scripts/subagents-route-smoke.ts openai-codex/gpt-5.6 /tmp/353-smoke-gpt-disabled adapter-disabled
bun scripts/subagents-route-smoke.ts anthropic/claude-sonnet-4-5 /tmp/353-smoke-anthropic
bun scripts/subagents-route-smoke.ts openai-codex/gpt-5.6-sol /tmp/353-smoke-sol-fixed
bun scripts/subagents-route-smoke.ts openai-codex/gpt-5.6-sol /tmp/353-smoke-sol-disabled-fixed adapter-disabled
```

## Offline behavior and presentation

Focused checks pass: **59 files, 889 tests, four existing skips**. These are controlled
scheduling/provider or renderer tests, not additional live-provider evidence.

| Area                                                                                     | Runnable coverage under `packages/ext/`                                                                                             |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Direct stock payloads, child model selection, adapter disabled, explicit selections      | `subagents/test/v2-exposure.test.ts` (intercepts before transport)                                                                  |
| Fresh/full/recent forks, cross-provider history, compaction and tool pairing             | `subagents/test/v2-history*.test.ts`                                                                                                |
| Queue-only information vs follow-up, repeated finals, user-input wait ordering           | `subagents/test/v2-messaging-e2e.test.ts`, `v2-wait.test.ts`, `subagent-messages*.test.ts`                                          |
| Pressure, unload/reload/reuse, descendant mail, approval reset, owner replacement        | `subagents/test/v2-residency-e2e.test.ts`                                                                                           |
| Active interruption, stale contexts, root/self authorization and descendant preservation | `subagents/test/v2-interrupt.test.ts`, `v2-messaging-e2e.test.ts`                                                                   |
| Late approval cancellation, per-command identity, Auto Mode/human escalation             | `bash-gate/command-authorization.test.ts`, `bash-gate/bash-gate.test.ts`, `automode/`                                               |
| Fleet/navigation and retained history                                                    | `subagents/test/fleet-*.test.ts`, `conversation-viewer*.test.ts`                                                                    |
| Direct and historical V1 saved display, no restored executors                            | `subagents/ui/subagent-message-render.test.ts`, `subagents/test/notifications.test.ts`, `codex-adapter/code-mode-rendering.test.ts` |
| Usage and tracked Pi panes separate from model content                                   | `subagents/test/usage.test.ts`, `session-tracker/`                                                                                  |

No new renderer behavior is inferred from the payload tests. Historical V1 text and
saved-display support are audit/presentation data only, not executable compatibility.

## Eager surface and prompt accounting

Sizes below are compact JSON **UTF-16 code units** (`JSON.stringify(value).length`),
not bytes or tokenizer counts. Tool lengths measure provider-converted declarations,
not generated output schemas. The six tools are eager in **every** request; there is
no collaboration discovery result and **no hidden-tool savings claim**.

| Payload                                    | All tools | Six tools | Six tools `ceil(chars/4)` estimate | Parent instructions | Child instructions |
| ------------------------------------------ | --------: | --------: | ---------------------------------: | ------------------: | -----------------: |
| Live Codex Responses, Code Mode            |    16,022 |     6,770 |                              1,693 |               2,669 |              8,568 |
| Live Codex Responses, adapter disabled     |     9,870 |     6,770 |                              1,693 |               3,637 |              9,482 |
| Offline OpenAI Responses, Code Mode        |    14,190 |     6,686 |                              1,672 |               2,692 |              8,577 |
| Offline OpenAI Responses, adapter disabled |     9,474 |     6,686 |                              1,672 |               3,660 |              9,491 |
| Offline Anthropic Messages                 |     9,495 |     6,655 |                              1,664 |               3,692 |              9,523 |

All-tools columns use the first parent request. Instructions include the complete
additive Pi/system/orchestration prompt, not just pinned collaboration descriptions.
Child-parent deltas include role/task guidance and environment/capability differences;
they are not an isolated attribution to a single prompt. OpenAI Responses carries
system/developer messages in `input`; offline export measures those separately from
ordinary history. Anthropic uses `system`; Codex Responses uses `instructions`.
Different wrappers, strictness and grammar/structured fallback explain why these are
not interchangeable contract lengths. The pinned declaration objects including
output schemas remain 8,594 characters (2,149 estimated tokens).

Live first-request provider usage is **4,066 input / 147 output** for the Code Mode
parent and **5,232 / 103** for its child; adapter-disabled equivalents are
**2,704 / 165** and **3,856 / 49**. These are whole-request provider reports, not a
local tokenizer measurement of the six tools or prompts. Cumulative input, cache,
output and reasoning fields remain separate in the JSON; reasoning can be a subset
of output and is not added again. No Anthropic token counts or cache savings are
claimed. No tokenizer-specific measurement of isolated contracts is available.

Reproduce offline payloads without credentials or inference:

```sh
SUBAGENTS_PAYLOAD_DIR=/tmp/353-payloads bunx vitest run packages/ext/subagents/test/v2-exposure.test.ts
```

This opt-in export preserves both synthetic parent/child bodies and measured fields,
including restricted-tool cases. Existing assertions still reject unexpected
transport calls. To inspect each `*-all.json`, read `characters` for the table;
`collaboration` filters the six names before compact serialization. For live captures,
apply that same filter to `payload-*.json`'s `tools`; the runner already records the
other size fields in `result.json`. Do not commit raw authenticated captures from
non-synthetic sessions; provider payloads can contain private context.

## Remaining maintainer disposition

- Supply an authenticated Anthropic route and rerun the lifecycle; offline payload
  conversion does not establish provider acceptance, replay or timing.
- Live full/recent forks, differently modeled children, capacity-pressure reload,
  parent/descendant routing, active interruption, user-input interruption of waits,
  late approval cancellation, Auto Mode/human escalation and lifecycle replacement
  remain unverified. The current live harness covers fresh forks and interruption
  of a settled task only; it does not claim these adversarial scenarios pass.
- Interactive Fleet/navigation, restored display and tracked-pane behavior have
  automated coverage, not a human terminal walkthrough. No application-restart
  recovery, additional host architecture or provider-side compaction claim is made.

A maintainer must explicitly accept/defer those gaps or request further live work
before calling the integration validated. There is no such disposition in this
record. Keep that release decision separate from tool-contract fidelity and from
review approval of this evidence change.

Final `bun check` passes: 1,546 main tests and 140 Bun tests, with four existing
skips. Lint, formatting and typechecking pass.

## Repository commands

```sh
python3 scripts/generate-subagents-v2-contract.py /home/jt/projects/codex --check
bun --bun vitest run scripts/subagents-route-smoke.test.ts
bunx vitest run packages/ext/subagents packages/ext/bash-gate packages/ext/automode packages/ext/session-tracker packages/ext/codex-adapter/code-mode-rendering.test.ts
bun run typecheck
bun check
```
