# Replace the structured Codex adapter with scoped Code Mode

Status: Accepted (2026-09-09), epic [#294](https://github.com/jamestrew/pi-bites/issues/294). Contract finalized by [#295](https://github.com/jamestrew/pi-bites/issues/295); implemented through #296–#302. See [cutover validation](../code-mode-contract/cutover.md) for evidence and live-route limitations.

Source definitions and supported deviations: [Code Mode contract baseline](../code-mode-contract/README.md).

For the GPT-5.6 and GPT-6 model families, including their named variants, replace the structured adapter interface with Codex-compatible Code Mode, initially nesting only `exec_command`, `write_stdin`, `apply_patch`, `web_run`, and `view_image`, subject to their availability policies. Preserve unrelated direct tools, including the independently usable subagent tools; collaboration now stays direct under the #352 amendment below. Models outside this scope use Pi's regular core tools rather than retaining a second structured Codex mode; remove the existing exception that exposes standalone `web_run` outside adapter scope.

GPT-5.6 and GPT-6 are the primary usage target. Keep unsupported-model handling to a simple fallback, and do not automatically activate future GPT families or all models belonging to a configured provider.

Preserve Codex-compatible JavaScript execution, tool signatures, and yielding while permitting documented Pi-specific output delivery differences. Exact harness parity would expand the work beyond the adapter; UI feedback followed by model-visible output at a yield is acceptable instead of immediate model-visible `notify()` delivery.

Use Codex's model-facing tool descriptions and contracts from one pinned revision as the source of truth, with one-for-one fidelity wherever supported rather than locally rewritten summaries or additional batching advice. Align straightforward behavioral differences such as defaults, and make only necessary, documented omissions for unsupported capabilities; do not advertise Codex sandbox enforcement or hosted web operations that Pi-bites does not implement. Codex's broader model instruction templates are distinct from its tool descriptions.

This supersedes issue #226's exclusion of Code Mode and its required runtime, while retaining stock Pi providers and authentication, additive prompts, independent web-routing policy, and the exclusion of Notebook Mode and unrelated upstream product features. Code Mode activation on a work provider does not authorize fallback to personal OpenAI credentials.

Retain bash-gate command classification and its automated-review or permission-UI paths for nested shell execution. RTK retirement was the separate prerequisite #292, completed in ancestor commit `6dc4c867`; the new dispatcher must not reintroduce its command-rewriting or output-filtering machinery.

The selected contract revision is Codex `rust-v0.145.0` / `25af12f7e61572b0bc18ddb1008be543b91519b0`, paired with conversion 3.0.31 / `94eb6c0745e2f516bf19603f912f7b6478b43355`. Extract exact source definitions and use the pinned description builder at build time. Retain stock Pi grammar capability detection and its documented `{code:string}` fallback. The baseline explicitly records the local `web_run` alias, original-only image helper, and supported output adaptations.

## Nested discovery policy (#304, 2026-09-12)

The four core nested contracts remain eager, subject to availability. Detailed `web_run` help is deferred using the pinned native `ALL_TOOLS` mechanism. Before browsing, the model prints `text(ALL_TOOLS.filter(tool => tool.name === "web_run"));` in a separate `exec` call and reads the complete retained contract, including citations and word limits. Initial help retains explicit browsing requests, changing information, recommendations involving substantial time or money, source attribution, referenced material, uncertain facts, and high-stakes accuracy as browsing triggers, plus the local-first OpenAI-product rule. This changes the timing of detailed instructions, not the intended browsing decision policy.

The pinned generator calls `augment_tool_definition` once per supported definition to supply full argument/return declarations in runtime metadata. Native deferred guidance is generated with a deferred list. The runtime still exposes enabled functions on `tools`; discovery returns ordinary text and does not invoke the dispatcher, authorize commands, contact a web route, or enable credentials. Availability and route validation remain execution-time checks. No tool re-registration, active-tool additions, or system-prompt mutation occurs on lookup.

This is an intentional local exposure policy: standalone native Codex web is eager at both inspected revisions. It is separate from top-level BM25 tool search and Pi additive dynamic loading. Discovery output preserves the preceding prompt prefix but does not guarantee cache hits, and consumes context once retrieved. Compaction may remove help; the model must rediscover it before subsequent web use. Restored help is documentation only: cells, processes, stores, and authorization are never restored from it. The host pin, stock transports/authentication, gate, cancellation, and rendering remain unchanged.

## Historical V1 subagent amendment (#305; superseded by #352)

The [V1 contract](../../packages/ext/subagents/CODEX_V1.md) now shares the selected
`25af12f7e61572b0bc18ddb1008be543b91519b0` baseline. One session-owned subagent engine
serves flat standalone Pi tools outside eligible Code Mode and native
`tools.multi_agent_v1__<name>` functions inside it; never expose both paths together.
Subagents remain independently disableable and usable without the adapter. V2 is not
a prerequisite: replacing its operation/task hierarchy would discard the existing V1
migration rather than finish it. Keep the host pinned.

Complete V1 help is declaration-bearing `ALL_TOOLS` metadata; retain eager delegation
capability and policy cues. Unconditional local deferral differs from upstream eager
V1 exposure without search, but must not depend on Responses search or abbreviate
pinned declarations. Measure initial help, discoverable declarations, discovery
history, and provider payload separately. Omit unsupported `items` and `service_tier`
explicitly. Roles inherit actual parent capabilities; explorer is not an additional
read-only boundary. #305 records the target; #306–#309 activate it after usable
close/resume (#276–#277), with combined validation in #278.

## Combined V1 validation (#278)

The two entry points are implemented on the integration branch. The
[combined audit](../code-mode-contract/subagents-validation.md) records actual route
and payload evidence, precise remaining limitations, and the existing behavioral
checks. Keep additive role/project guidance separate from pinned declarations;
child prompts refer to available capabilities rather than assuming direct core tools.
The final merge into `master` is a separate integration action, not part of this audit PR.

## Direct V2 collaboration (#352)

Replace V1 and nested collaboration with one six-tool direct surface on every
Pi tool-calling provider/model, including adapter-disabled sessions. No model-family
selector, mode switch, nested V2, subagent `ALL_TOOLS` metadata, discovery prerequisite,
or `tool_search` remains. Explicit selections, extension disables, parent capabilities
and additive delegation/project/skill policy still apply. Children use the same
permitted tools across provider switches. The independent Code Mode host pin, model
scope, native tools and stock grammar/transport handling do not change.

Use the [V2 contract](../../packages/ext/subagents/CODEX_V2.md) rather than the
historical V1 paragraphs above for task/message behavior. Completion is queue-only,
waits observe mailbox activity, and retained task identity is separate from execution
capacity and runtime residency. [Verification](../code-mode-contract/subagents-v2-cutover.md)
separates offline payload evidence from release smoke limitations.

The [#353 release validation record](../code-mode-contract/subagents-v2-validation.md)
adds live GPT Code Mode/adapter-disabled evidence and eager-surface measurements.
Anthropic and the remaining adversarial live scenarios require explicit maintainer
disposition before the integration is called validated; review or merge of the
evidence does not waive that gate. This does not authorize integration into `master`.

## GPT-6.1 and direct OpenAI login amendment (#365)

Extend the bounded model policy to `gpt-6.1` and `gpt-6.1-sol`, including the
existing normalized, recognized provider prefixes. This explicitly amends the
previous GPT-6.1 exclusion, not the general future-model exclusion. GPT-5.6/GPT-6
variants, tool permissions, direct collaboration, pinned host and generated native
contracts remain unchanged.

Model eligibility grants no subscription access. Direct `openai` ChatGPT OAuth
uses the standard Responses endpoint with a separate grant; it does not authorize
legacy Codex usage or search. Keep unsupported direct capabilities unavailable,
preserve legacy login and explicit cross-provider fallback, and reserve the
compatible-provider allowlist for independently verified provider IDs.
[Verification and recovery](../code-mode-contract/openai-compatibility.md) distinguish
upstream source evidence from live transport validation.

## Native parent amendment (#369)

For parent sessions, the accepted [native parent contract](../code-mode-contract/native-parent.md)
supersedes runtime-specific statements above: use Pi 0.99.1 native `codemode`,
registry discovery, one-shot finalization and native nested rendering/persistence.
No parent V8 host, live cells or exec/wait facade remain. Keep the bounded model
scope, concrete capabilities, shared per-launch authorization and route restrictions.
The child path retains this historical host contract until its separate migration.

## Native SDK child amendment (#370)

The native amendment above also applies to SDK children. Parent and child sessions
share native registration, one-shot execution, ownership cleanup and per-launch
authorization. Explicit SDK builtin factories and the child's registry ceiling keep
parent permissions separate from discovery. Direct V2 collaboration remains
independent; see the [native adapter contract](../code-mode-contract/native-parent.md).
The historical host code/tests await separate retirement, not a selectable fallback.
