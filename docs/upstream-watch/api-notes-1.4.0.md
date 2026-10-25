# Pi 1.4 API compatibility notes

Reviewed 2026-10-25. Narrow supporting research for the 1.0.0 → 1.4.0 review; no implementation, dependency, or checkpoint changes.

**Planning follow-up:** the working checkout predates [PR #400](https://github.com/jamestrew/pi-bites/pull/400), which closed [#397](https://github.com/jamestrew/pi-bites/issues/397). GitHub `master` already prefers recorded nested durations, assigns child render durations explicitly, and consumes settlement abort metadata. The duration/cancellation findings below describe the older checkout; follow-up work should verify the merged implementation on Pi 1.4, not duplicate it. Web self-shell padding still ignores `outputPad` on both inspected baselines.

## Primary sources

- Installed official 1.4 documentation root: `/nix/store/5p12wbg5xsbpciqpn3fcjld3lcjb7b2x-pi-1.4.0/libexec/pi/`. Read `docs/extensions.md`, `docs/tui.md`, `docs/settings.md`, `docs/compaction.md`, `docs/codemode.md`, and `docs/sessions.md`; checked `examples/extensions/built-in-tool-renderer.ts` and `prompt-customizer.ts`.
- The installed Nix distribution is a compiled executable without `dist/` source. Exact implementation checks use the official [published 1.4.0 npm tarball](https://registry.npmjs.org/@earendil-works/pi-coding-agent/-/pi-coding-agent-1.4.0.tgz), extracted temporarily to `/tmp/pi-upstream-api-iYquVX/package/`. Paths below beginning `dist/` refer to that artifact, not the local 1.2.0 development dependency.
- Release attribution comes from [`latest.md`](latest.md).

## Adapt: self-shell web renderer ignores outputPad

**Upstream 1.1.0:** `outputPad` now applies to tool output and is supplied in the render context. `dist/core/extensions/types.d.ts:377` explicitly assigns horizontal-padding responsibility to `renderShell: "self"` renderers. Installed `docs/settings.md` documents `outputPad` as `0 | 1`, default **1**.

**Local evidence:** `packages/ext/codex-adapter/web-run/tool.ts:519–522` declares `renderShell: "self"` but builds `new Box(0, 1)`, retaining vertical padding while ignoring horizontal configuration. `packages/ext/tools.ts` forwards the host render context to inherited read/bash/edit renderers, so those already receive the setting.

**Next:** apply `context.outputPad` at the standalone web renderer's outer shell, and check both values in collapsed/expanded output. Account for `native-rendering.ts` embedding this renderer inside the codemode shell so nested rows do not acquire accidental double horizontal padding. No broad renderer rewrite is required.

## Leverage: recorded execution durations

**Upstream 1.1.0:** `ToolRenderContext.durationMs` is the final recorded execution duration, undefined during execution or for older results. `ToolExecutionEndEvent.durationMs` is optional and measures `execute()` with a monotonic clock (`dist/core/extensions/types.d.ts:371–378, 878–880`).

**Local evidence:** `packages/ext/codex-adapter/native-rendering.ts:151` persists `Date.now() - call.startedAt`, whose start is `tool_execution_start`, before policy hooks. It can include approval waits and clock changes. Its nested renderer context at lines 362–375 spreads the parent context without assigning the child's duration. `packages/ext/tools.ts` already spreads the original built-in definitions and forwards contexts; keep its separate post-approval live bash timer behavior.

**Next:** prefer `event.durationMs` when persisting nested completion, optionally retaining the old wall-clock calculation only when absent for older hosts; pass `call.durationMs` into the child context, not the parent's duration. Test duration differing from wall time and restored nested results. Subagent task lifetime durations are a different measure and should not be replaced with one tool's execution duration.

## Leverage: aborted settlement is explicit

**Upstream 1.1.0:** `AgentSettledEvent.aborted: boolean` identifies cancellation. `dist/core/agent-session.js:689–690` emits it to extension and session subscribers; `types.d.ts:801–805` describes the contract.

**Local evidence:** `packages/ext/subagents/v2-tools.ts:53` ignores the event and derives terminal root state from the last assistant's `stopReason` at `agent_end`. This does not necessarily describe a cancellation during later compaction or settlement. `packages/ext/session-tracker/index.ts:717` also ignores it and classifies pending assistant text. `subagents/agent-manager.ts:212` frees execution capacity on every settlement.

**Next:** consider using `event.aborted` to report `interrupted` reliably in root task observations and to avoid cancellation-triggered needs-input classification if that matches tracker policy. Keep capacity release unconditional: aborted runs release slots too. Do not blanket-skip `auto-compaction.ts` on aborted settlements: it deliberately aborts between turns and resumes after compaction.

## Already adopted: before_agent_start custom starts and busy state

**Upstream 1.2.0:** `BeforeAgentStartEvent` is discriminated by `messageType`; user events contain `prompt`/`images`, custom events contain `message` and no `prompt`. Returned context messages are added to either run. The session is busy throughout preparation, and queued `nextTurn` messages enter custom-message runs. See installed `docs/extensions.md`, Events and concurrency; artifact `dist/core/extensions/types.d.ts:720–742` and `dist/core/agent-session.js:1419–1528`.

**Local evidence:** `packages/ext/inline-references/index.ts:136` guards `"prompt" in event` before parsing. Ponytail's hook (`ponytail/index.ts:126`), adapter prompt preparation (`codex-adapter/native-registration.ts:469`), and child scope/prompt hooks (`subagents/operations.ts:175,189,236`) only use common prompt/context fields. They appropriately execute for custom starts. `auto-compaction.ts` creates an idle custom-message continuation that benefits from preserved prompt hooks.

**Next:** retain the guard and smoke-test an automatic-compaction continuation and an idle custom-message run with pending context. Do not add user-only guards to shared system-prompt setup. No confirmed migration defect exists in these handlers.

## Already adopted: reachesTools through native codemode

**Upstream 1.2.0:** orchestrators declare `reachesTools(input): "all" | readonly string[]`; words indicate tool or namespace reachability. Native MCP uses this to wait for still-connecting servers and recognizes replacement `codemode`/`tool_search` only when they declare it. Installed `docs/extensions.md`, Tool exposure, and artifact `dist/core/extensions/types.d.ts:490` define the seam.

**Local evidence:** `packages/ext/codex-adapter/native-registration.ts:61–74` creates the genuine native `createCodemodeExtension`, wraps registration, and spreads the decorated tool. `native-rendering.ts:187–193` also spreads the native definition. Neither strips `reachesTools` or replaces execution with an unrelated orchestration tool.

**Next:** preserve this metadata and run one MCP-connecting/codemode smoke after upgrading. Do not add a redundant callback or reimplement MCP readiness locally.

## Watch: registerToolRenderer is available, not a required migration

**Upstream 1.0.1:** `pi.registerToolRenderer((toolName, next) => renderers)` handles even not-yet-registered tools; `next()` delegates through later resolvers, then the registered tool. See installed `docs/extensions.md`, Tool rendering; artifact `dist/core/extensions/types.d.ts:520–526` and `dist/core/extensions/runner.js:542–546`.

**Local evidence:** no local `registerToolRenderer` consumer exists. `packages/ext/tools.ts` overrides behavior and metadata as well as presentation, and `native-registration.ts`/`native-rendering.ts` decorate execution updates and retained nested display details. Resolver registration cannot replace those complete responsibilities.

**Next:** use the resolver if a future presentation-only fallback for unregistered/MCP tools is needed; `next() ?? fallback` fills gaps without overriding another renderer. No immediate refactor.

## Leverage: summary output cap fix, no local parameter migration

**Upstream 1.4.0:** `generateSummary()` and `generateSummaryWithUsage()` retain but ignore `reserveTokens`; summary options no longer impose a fixed `maxTokens`. Compaction reserve still controls the trigger threshold. Source: installed `docs/compaction.md`, When It Triggers; artifact `dist/core/compaction/compaction.js:463–468,494–515`. The provider applies its ordinary output/context limit.

**Local evidence:** no local calls to either summary function or custom summary-output cap were found. `packages/ext/auto-compaction.ts` delegates to `ctx.compact()` or the guarded private `_runAutoCompaction` seam; its `thresholdTokens` setting controls when to compact, not summary output. Lifecycle consumers in `session-tracker/index.ts` and `subagents/subagent-messages.ts` observe compaction rather than replacing the summary generator.

**Next:** inherit the fix and smoke-test long-reasoning compaction and split-turn instructions. Keep the local threshold semantics; do not interpret this as a reason to delete threshold controls. It is not evidence that the private child compaction seam can be removed unchanged.

## Leverage/watch: active-tool restoration

**Upstream 1.3.0, 1.4.0:** resume restores transcript-declared tools, applies `+name`/`-name`, preserves tools added after the branch's recorded loadout unless opted out with `defaultActive: false`, and restores this on tree navigation. `dist/core/agent-session.js:1389–1412` replays system-message tool changes, distinguishes removed tools from never-mentioned extension tools, and records not-yet-registered names pending registration.

**Local evidence:** `packages/ext/codex-adapter/native-registration.ts` already registers owned tools with `defaultActive: false` (line 158), reconciles on `session_start`, `session_tree`, model selection, and run boundaries, and rewrites active tool selections. `packages/ext/spotme/index.ts:21–26` toggles its tools via `setActiveTools`; other subagent tools register normally. The 1.4 restoration fix benefits newly installed subagent tools; owned adapter tools deliberately do not become active solely by restoration default.

**Next:** upgrade and smoke-test resumed/tree-switched sessions with an explicitly deactivated tool and a newly installed extension tool. Keep adapter reconciliation until its model-sensitive owned-tool projection is proven redundant; it is not just a workaround for upstream resume bugs. Explicit CLI tool ceilings must still win.

## Leverage: upstream grep ignores RIPGREP_CONFIG_PATH

**Upstream 1.4.0:** built-in grep starts ripgrep with `--no-config`, making literal/regex semantics independent of user ripgrep configuration (`dist/core/tools/grep.js:93–95`).

**Local evidence:** no direct local ripgrep invocation or custom grep implementation was found in extension TypeScript. `packages/ext/file-search/index.ts` uses `@ff-labs/fff-node` for filename mentions, not content regex search. Bash-gate policies mention `rg`, but do not execute it. Model-issued `rg` through bash/exec is a user shell command and is not the built-in grep contract.

**Next:** inherit the built-in fix; no local `--no-config` patch is needed. Do not silently rewrite arbitrary user shell commands.
