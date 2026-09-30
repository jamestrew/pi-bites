# Direct V2 cutover (#352)

This is the cutover-time record. See [#353 release validation](subagents-v2-validation.md)
for later successful named GPT routes, current measurements and unresolved live gaps.

The integration branch activates the six direct V2 tools on all Pi tool-calling
models. The V1 executors, selected-agent waits, automatic turn-triggering completion
path, nested collaboration bridge/metadata/generator, and staged V2 registration are
removed. Code Mode's five unrelated nested capabilities, host pin, provider transport,
grammar handling, web discovery and child shell/file permission recovery are unchanged.

The session-owned controller still validates arguments, capability ceilings, owner
generations and cancellation before executing. Children inherit current permitted
tools even when choosing another provider. Model switching changes Code Mode's own
projection, not subagent controls or live task ownership. Internal programmatic spawn
receives a generated task path, intersects current delegated capabilities, and awaits
shared residency admission before initialization. Sequential registry/RPC spawns obey
the same loaded-runtime ceiling as direct tools.

Saved V1 notifications retain their display renderer; removed tool names and saved
nested traces use read-only fallback output. Saved selected-target wait results remain
readable under the current `wait_agent` renderer, but their arguments cannot execute.
Saved displays never restore live agents. Internal manager close/recovery and Fleet
commands remain; they are not a model-callable compatibility surface.

## Offline verification

`v2-exposure.test.ts` creates real parent and embedded child Pi sessions, constructs
stock OpenAI Responses and Anthropic payloads, and stops before transport. It covers
GPT Code Mode, adapter-disabled GPT, Anthropic, an older GPT outside adapter scope,
explicit tool selections, child model overrides, model switching with retained work,
and subagent disables. Every payload has exactly the permitted direct collaboration
names and no nested collaboration, old controls or discovery prerequisite. No network
request is made by these tests. Existing transport tests retain Codex Responses grammar
and structured fallback checks; child shell/file recovery remains independently tested.

The V2 integration suites now use ordinary registration, not an alternate harness.
They retain mailbox/wait input ordering, repeated completion, interruption, history,
residency/reload, stale-context, approval-reset, capacity and lifecycle regressions.
Fleet approval and print-mode tests use V2 task names and queue-only completion.
Historical display regressions do not register V1 executors.

The six pinned declaration objects serialize to 8,594 characters (approximately
2,149 tokens using characters/4, not a tokenizer measurement). This excludes Pi's
system-prompt guidelines, tools from other extensions, history and provider wrappers.
There is no separate collaboration discovery/history payload anymore. Live request
token measurements are unavailable; the smoke runner records actual payload, tool,
instruction and history character counts when an authenticated route is available.

## Live-route limitations

The following exact commands run on this workspace. All three report **unavailable**:
requested route absent or unauthenticated; no substitute model/provider is used.
No live provider acceptance, tool timing, or approval round trip is claimed.

```sh
bun scripts/subagents-route-smoke.ts openai-codex/gpt-5.6 /tmp/352-smoke-gpt
bun scripts/subagents-route-smoke.ts openai-codex/gpt-5.6 /tmp/352-smoke-gpt-disabled adapter-disabled
bun scripts/subagents-route-smoke.ts anthropic/claude-sonnet-4-5 /tmp/352-smoke-anthropic
```

The runner now exercises direct named spawn, child parent-address mail, exact-command
approval, mailbox wait/list completion, interruption of a settled task, and follow-up
recall without repeating the marker. It captures parent/child payloads and separates
completion mail from lifecycle/UI events. Authenticated GPT/Anthropic smoke remains a
release-validation requirement; offline payload coverage is not a substitute. This
cutover targets `codex-subagents-v2`, not a release or merge into `master`.

Final repository validation: `bun check` (lint, formatting, typechecking, main tests,
and Bun host/transport/script tests).
