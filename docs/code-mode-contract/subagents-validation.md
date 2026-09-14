# Combined V1 parity audit (#278)

## Integration boundary

Validated on 2026-09-13 against `subagents-codex` base
`f8b65c9c636832061bff77f2b9d540ac533f31db`. GitHub reports #271–#277,
#305–#309, and the #294 foundation closed. The native `blocked_by` list for #278
contains #273, #274, #275, #276, #277, and #309, all closed. This PR targets
`subagents-codex`; preparing/merging the final integration into `master` remains a
separate action. Neither this audit nor a passing smoke closes the epic itself.

The shared controller is the only execution/validation/ownership seam. The adapter
consumes its definitions and renderers without supplying another manager or policy.
Root and child composition select five flat tools outside Code Mode, five namespaced
nested functions inside eligible Code Mode, and neither when disabled. Unrelated
tools and explicit selections survive transitions; model changes preserve agents.
Legacy tool registrations, aliases, injected parent-message helper, and read-only
explorer restrictions are absent. Internal `WaitAgentStatus`/renderer names and
historical research are not compatibility surfaces. Unused token-budget constants
and the runner's obsolete exclusion-name table are removed.

## Corrections against the pin

At unchanged Codex `25af12f7e61572b0bc18ddb1008be543b91519b0`:

- `multi_agents/spawn.rs` trims role names before fork validation; `agent/role.rs`
  performs case-sensitive lookup. Local role validation now rejects `EXPLORER` and
  treats blank roles as omitted, even for full-history forks.
- `multi_agents/send_input.rs` sends interruption before input without requiring a
  running status. Settled open Pi sessions now accept input after success, error,
  or interruption; `interrupt: true` also works immediately after explicit resume.
  Running-turn interruption retains the existing serialized cancellation path.
- `agent/status.rs::is_final` excludes `Interrupted`; `multi_agents/wait.rs` uses
  that predicate. Selected waits now span interrupted generations, do not emit an
  automatic final for interruption, and release when that interrupted agent closes.
- Child guidance no longer commands absent direct read/edit/find/grep tools or
  claims unrestricted access. Parent addressing describes both entry points.
  Eager collaboration help names capacity retention and independent wait/final
  delivery. Pinned declarations and additive project/skill prompts are preserved.

Necessary Pi adaptations remain explicit in [CODEX_V1.md](../../packages/ext/subagents/CODEX_V1.md):
plain-text input, no service tier, opaque owned IDs, stock provider/model diagnostics,
output schemas as nested metadata, in-memory owned recovery rather than cross-process
persistence, next-model-boundary delivery, no parent interruption/self-close, and no
Codex sandbox claim. During initial child loading there is no live session to
interrupt: interrupting input fails explicitly, while ordinary input queues. No
uncommitted work acquires a fabricated native rollback guarantee.

## Behavioral evidence

| Seam                                                            | Coverage                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `code-mode-subagents.test.ts`                                   | Same direct/native-host scenarios for role validation, retained-turn input after completion/error, resume and history, independent final delivery, structured values/errors; native discovery/rediscovery, selected controls, independently modeled children, actual namespace identity, parallel calls, yield/outer wait, failed cells, cancelled waits, model switches, missing host, late spawn/reopen, tree replacement and throwing ctx getters |
| `subagents/test/operations.test.ts`, manager/tree/reopen suites | Fork/no-fork inheritance, actual model/tool/reasoning scope, shared capacity and depth, descendant ownership, target permissions, submission/cancellation boundaries, reservation rollback, retained conversation/compaction, stale snapshots and independent waiters                                                                                                                                                                                |
| Completion and lifecycle suites                                 | Selected targets only, independent notification, interrupted waits continuing to later generations or close, reuse after interruption, no duplicate finals, retained slots and exactly-once teardown                                                                                                                                                                                                                                                 |
| Child E2E and approval suites                                   | Real child sessions with controlled provider inference; parent messaging, child model-specific exposure, permission inheritance, two-hop escalation, per-command identity, queued dialogs/allowance rechecks, late approvals and cancellation                                                                                                                                                                                                        |
| Code Mode runtime/connection/registration/transport suites      | Cell/agent/shell separation, host failure, background/TTY shells, branch/session/reload/shutdown cleanup, grammar and structured fallback with stock transport conversion                                                                                                                                                                                                                                                                            |
| Existing renderer/Fleet suites and native-host restored traces  | Five recognizable nested rows, hidden default JavaScript, bounded/restored data, narrow/collapsed/expanded layouts, navigation and no manufactured model tool results                                                                                                                                                                                                                                                                                |

The new parity assertions fail before their shared-seam fixes and pass afterward.
Controlled child loaders isolate lifecycle scheduling; they do not claim live inference.
The route smoke below additionally uses real child sessions and provider requests.
Native host/source/generated tooling is unchanged, so no new locked Rust build is
needed. Contract regeneration with `--check` passes. Linux x64 host tests run locally;
this change does not add physical arm64 validation.

## Live stock-provider routes

`scripts/subagents-route-smoke.ts` loads the real controller, adapter, and bash gate,
then lets the model execute the lifecycle. Parent and child hooks capture actual
provider requests, tool results, and usage. A private temporary agent directory gets
only the selected stored credential (0600), isolated settings, and synthetic prompts;
it is removed on completion. No repository files or existing conversation are sent.
The scripted permission UI approves only `printf subagent-approved` and denies every
other command. This exercises the production child-to-parent manual approval broker,
not a human terminal or live Auto Mode reviewer. It does not authorize broader work.

Successful runs discover complete V1 help when nested, spawn an explicitly same-model
default child, execute the approved command, deliver parent progress and independent
finals, close/resume the same identity, recall a marker without repeating it in new
input, wait, and finally close. Nested runs also yield a cell and resume via outer
wait. Each success records 12 actual requests: Sol uses seven parent and five child
requests; the other successful runs use eight parent and four child requests.

| Route/scenario                                      | Observed outcome                                                                                                                                                                                                                                                  |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `openai-codex/gpt-5.6-sol`                          | Pass, nested parent and child, custom grammar `exec` and function `wait`                                                                                                                                                                                          |
| `openai-codex/gpt-6-astra`                          | Pass, same nested lifecycle, discovery, yield, approval and retained recall                                                                                                                                                                                       |
| `openai-codex/gpt-5.5`                              | Pass, non-Code Mode parent and child with flat five-tool lifecycle plus normal core tools                                                                                                                                                                         |
| `openai-codex/gpt-5.6-luna`, adapter disabled       | Pass, flat lifecycle in both parent and child                                                                                                                                                                                                                     |
| `openai-codex/gpt-5.6-luna`, adapter enabled        | Two corrected-harness runs complete the subagent lifecycle but fail outer wait: model omits the `:cell` suffix of the returned cell ID. The runtime rejects the unknown ID; no alias or silent fallback is introduced. This route is not certified by those runs. |
| `openai-codex/gpt-5.4-mini`, `openai-codex/gpt-5.4` | Catalog/auth checks succeed, but actual provider requests reject the models as unsupported for this ChatGPT account. No child launches.                                                                                                                           |
| Work/custom, direct OpenAI, Anthropic routes        | No configured authenticated route found; not exercised.                                                                                                                                                                                                           |

Initial Luna/Astra/adapter-disabled trials exercise all lifecycle checks but report a
smoke UI error: the harness omits `onTerminalInput`. Supplying that required UI stub
fixes the harness; those initial failures remain in the evidence. The failed Luna
outer waits remain failures, not reclassified as runtime passes. No live route tests
forking, grandchildren, human terminal interaction, or provider-side compaction;
those are controlled behavioral coverage or explicit manual limits.

Commands for the successful probes (failed trial commands and captures are identified
by run name in the [measurement record](smoke/subagents-results.json)):

```sh
bun scripts/subagents-route-smoke.ts openai-codex/gpt-5.6-sol /tmp/subagents-278-sol
bun scripts/subagents-route-smoke.ts openai-codex/gpt-6-astra /tmp/subagents-278-astra-final
bun scripts/subagents-route-smoke.ts openai-codex/gpt-5.5 /tmp/subagents-278-direct-55
bun scripts/subagents-route-smoke.ts openai-codex/gpt-5.6-luna /tmp/subagents-278-disabled-final adapter-disabled
```

## Size and actual payload accounting

[Recorded measurements](smoke/subagents-results.json) distinguish compact JSON UTF-16
character counts from provider-reported tokens. Raw synthetic captures remain in the
listed local `/tmp/subagents-278-*` directories; the retained record includes hashes,
request counts, observed tools, initial payload sizes, discovery history wrapping,
and separate parent/child usage. Usage belongs to whole requests, not individual
contracts; none of these numbers establishes cache savings.

| Artifact                                                                     | Characters | `ceil(chars / 4)` estimate |
| ---------------------------------------------------------------------------- | ---------: | -------------------------: |
| Serialized supported five-tool direct contract, including outputs            |     11,675 |                      2,919 |
| Eager grammar Code Mode help, four core tools + collaboration, excluding web |      7,952 |                      1,988 |
| Collaboration-only eager delta over those same core tools                    |      1,666 |                        417 |
| Full five-tool `ALL_TOOLS` name/description JSON                             |     10,710 |                      2,678 |
| Default child append with parent `PARENT`, cwd `/tmp/smoke`, non-git Linux   |        665 |                        167 |
| Additional explorer role prompt                                              |      2,472 |                        618 |

Reproduce artifact lengths using `serializeCodexV1Contract`, `execDescription` with
and without the five `CODEX_V1_NESTED_TOOLS` names, their `runtime_description` fields,
and `buildAgentPrompt(DEFAULT_AGENTS.default, ...)`. Role guidance is additive, not
another copy of the native contract. Historical 1,605/2,902 estimates and the former
2,000 soft target do not justify dropping native prose.

Sol's actual initial parent payload contains 14,519 characters: 10,928 tool characters,
1,690 instruction characters, and 1,592 input/history characters (remaining fields are
transport framing). Its first complete discovery output is 10,758 characters, or
11,094 with the actual history-item wrapper. Astra's corresponding discovery item is
11,144 characters because the model's printed framing differs. Both include full
runtime declarations. Rediscovery remains stateless; another lookup consumes history
again. Flat direct provider requests contain 12,479 tool characters, including core
tools and transport omissions of output schemas; this is not the 11,675 comparison
contract serialized above. First and cumulative provider input/cache/output counts
are retained separately for each owner and route.

## Repository validation

```sh
python3 scripts/generate-subagents-contract.py /home/jt/projects/codex --check
bunx vitest run packages/ext/subagents packages/ext/codex-adapter/code-mode-subagents.test.ts packages/ext/codex-adapter/code-mode-rendering.test.ts packages/ext/codex-adapter/vendor-boundary.test.ts
bunx vitest run packages/ext/subagents/test/agent-completion.test.ts packages/ext/subagents/test/operations.test.ts packages/ext/codex-adapter/code-mode-subagents.test.ts
bunx vitest run packages/ext/subagents/test/agent-manager-lifecycle.test.ts
env -u PI_PACKAGE_DIR bun --bun vitest run scripts/subagents-route-smoke.test.ts
bun run typecheck
bun check
```

Final `bun check` passes: 1,493 main tests and 97 Bun tests; four pre-existing
skips, no native-host skips. Lint, formatter, and typechecking pass. An earlier
invocation stops at lint on a redundant optional chain introduced in `send_input`;
removing it allows the full validation above to run successfully.

The first review identifies a concurrent close/wait gap after interruption. Closure
now publishes shutdown on the lifecycle-owned record before notifying observers,
so both existing waiters and waits started while teardown is pending see closure.
The completion handler only observes that durable state; composition no longer
special-cases interruption. A regression uses the real `AgentCloser` with deferred
teardown and both early and late waits.
