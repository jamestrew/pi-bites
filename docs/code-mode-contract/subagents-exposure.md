# V1 Code Mode exposure (#308)

The composition root creates one session-owned subagent controller before registering
Code Mode. The adapter consumes that controller's operations and renderers; it never
looks up third-party executors. Unsupported models and adapter-disabled sessions keep
flat standalone V1 controls. Supported sessions nest only selected capabilities, and
restore direct collaboration when either `exec` or outer `wait` is unavailable.
Children repeat this projection using their own model and inherited tool selection.

The pinned generated declarations from `subagents-supported.json` supply complete
input and return types through `ALL_TOOLS`. Initial help retains the explicit
user/AGENTS.md/skill permission requirement, delegation policy, discovery instructions,
and the distinction between outer cell waits and nested agent waits. Full collaboration
help is locally deferred on every eligible route, without Responses tool search.
Rediscovery is stateless, including after compaction removes prior documentation.

Host metadata carries both the normalized JavaScript name
`multi_agent_v1__spawn_agent` and native identity
`{namespace: "multi_agent_v1", name: "spawn_agent"}` (likewise for the other four
operations). Delegate authorization matches the exact native identity, not a flattened
alias. The existing protocol and host support this; no host upgrade or Rust change is
necessary. Stock provider authentication, grammar capability detection, structured
`{code:string}` fallback, cancellation, and shell ownership remain unchanged.

Nested execution rechecks current selected controls, the subagent disable flag, and
the controller's caller/owner/capability restrictions. Discovery never launches agents
or authorizes work. Success returns the controller's V1 object; failures reject, with
UI details retained only in the enclosing trace. Existing subagent renderers render
those traces without separate Pi tool messages. #309 retains the broader presentation
and approval/lifecycle integration audit.

Outer tool execution snapshots the active context before awaiting. Lifecycle snapshots
also support already-running cells; permitted spawning snapshots fork history because
a deferred delegate cannot read a captured Pi context. Leaving Code Mode clears cells
and stores, not established session-owned agent identities. Terminating an agent wait
removes the waiter, not the agent. Controller ownership remains authoritative on
navigation, replacement, and shutdown.

## Validation

`code-mode-subagents.test.ts` uses the real native host and shared subagent manager;
only child model execution/session loading is substituted. It exercises namespace
discovery and rediscovery, actual stock Responses tool conversion before/after
discovery, direct/nested payloads and errors, parallel calls, yield/outer wait,
close/resume/send, cell cancellation, supported/unsupported switches, adapter/subagent
registration disables, explicit tool selection, differently modeled children, missing
hosts, stale metadata, throwing context getters, and live/restored renderer framing.
Existing runtime/connection tests cover host crashes, native rejection/cancellation,
and mismatched namespace authorization. Existing transport tests cover grammar and
structured payloads for Responses, Codex Responses, and Chat Completions.

Focused checks and final `bun check` pass (1,478 main tests, 96 Bun tests, four
existing skips). The first full run also catches the obsolete flat-tool expectation
in the child E2E test; that scenario now executes namespaced parent messaging through
the real child session. A shell-reaping poll and the existing five-second child test
time out once under full-suite load; focused checks and the final full retry pass
without changing their deadlines. This unattended run does not use
maintainer credentials or exercise live provider inference, real child model requests,
or interactive human approval; those remain the combined #278/#309 validation work.
The host integration runs locally on Linux x64, not an additional arm64 smoke run.

## Size accounting

Character measurements on this change (rounded-up characters/4 are estimates, not
provider tokenizer counts):

| Surface                                              | Characters | Estimated tokens |
| ---------------------------------------------------- | ---------: | ---------------: |
| Serialized standalone five-tool contract             |     11,675 |            2,919 |
| Additional eager Code Mode collaboration guidance    |      1,499 |              375 |
| Full collaboration `ALL_TOOLS` name/description JSON |     10,710 |            2,678 |

The last row also measures the compact JSON text retained by the discovery call,
excluding outer tool-result framing. Eager guidance is the length difference between
`execDescription` with and without the five collaboration names (same core tools and
grammar capability). Discoverable help includes generated input/return declarations.
Standalone serialization uses `serializeCodexV1Contract`; it excludes additive system
prompts. Provider conversion is exercised, but no live provider tokenizer usage or
cache-saving claim is made.
