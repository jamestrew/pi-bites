# Pi upstream review — 1.0.0 → 1.4.0

Reviewed: 2026-10-25. Source: [`latest.md`](latest.md), fetched by the bundled helper from the published `@earendil-works/pi-coding-agent` npm tarball. Primary API verification: [`api-notes-1.4.0.md`](api-notes-1.4.0.md), checked against the installed 1.4.0 docs and exact published implementation.

Checkpoint remains **1.0.0**, last checked **2026-10-02**. Eight releases contain **206 changelog bullets**, including repeated feature summaries: **9 adapt, 69 leverage, 125 watch, 3 irrelevant**. Every source bullet is assigned once below. `version/item` means its 1-based bullet index within that release; line references point into the fetched snapshot. Entries grouped together inherit the group’s upstream summary, local evidence, and action. Ignore means `irrelevant`.

**Bottom line:** one concrete padding mismatch, an already-adopted lifecycle migration, and restored-tool compatibility checks. The best small improvements are recorded nested durations and cancelled-settlement reporting. No extension implementation, dependencies, or checkpoint were changed for this review.

**Planning follow-up:** GitHub `master` already contains the duration and cancellation fixes from [#397](https://github.com/jamestrew/pi-bites/issues/397), merged in [PR #400](https://github.com/jamestrew/pi-bites/pull/400). This review's working checkout predates that merge. L2 and L11 below describe gaps in that checkout, not missing implementations on current GitHub `master`; their follow-up specs verify the merged behavior on Pi 1.4 rather than reimplement it. The self-shell web padding mismatch remains on both inspected baselines. The custom-start guard was already delivered by [#396](https://github.com/jamestrew/pi-bites/issues/396).

**Validation:** `bun check` passed (98 test files; 1,448 tests passed, 4 skipped), against the repository’s pinned **Pi 1.2.0** development dependencies. This is not a claim of tested 1.4.0 compatibility. Align both Pi dev dependencies and the lockfile, rerun checks, then run installed-CLI and interactive/route smokes before accepting an upgrade.

## Adapt

### A1 — Honor host padding in the self-rendered web tool

**Upstream:** `outputPad` is supplied to renderers and now applies to tool output as well as shell and summary output.

**Local evidence:** `packages/ext/codex-adapter/web-run/tool.ts:519–522` declares `renderShell: "self"` but constructs `new Box(0, 1)`; no production renderer reads `outputPad`. `packages/ext/tools.ts` instead inherits built-in shells. Pi documents horizontal padding as the self-shell renderer’s responsibility; vertical padding of 1 is already correct.

**Next action:** Use the host horizontal padding for standalone web rows, preserving vertical padding and width bounds. Check the nested web preview in `codex-adapter/native-rendering.ts` so the enclosing codemode shell does not cause double padding. Cover outputPad 0/1, narrow widths, collapsed/expanded, and restored results. This is a presentation mismatch, not an execution blocker.

<details>
<summary>Classified source entries</summary>

- **1.1.0/08** (line 194; [source](latest.md#110)): Added `outputPad` to the tool render context ([#10557](https://github.com/earendil-works/pi/pull/10557) by [@rwachtler](https://github.com/rwachtler))
- **1.1.0/15** (line 204; [source](latest.md#110)): Changed `outputPad` to also apply to `!` command output, tool output, and summary blocks ([#9946](https://github.com/earendil-works/pi/issues/9946), [#10557](https://github.com/earendil-works/pi/pull/10557) by [@rwachtler](https://github.com/rwachtler))

</details>

### A2 — Validate restored tool selection, without loosening permissions

**Upstream:** Resume restores session-active tools, CLI +/− adjustments apply on top, and previously unmentioned extension tools become active unless defaultActive is false.

**Local evidence:** `packages/ext/codex-adapter/native-registration.ts` explicitly sets owned tools `defaultActive: false`, seeds `state.selection` once, and reconciles on session_start/session_tree/model_select/turn_start/before_agent_start. `activation.ts` caches the initial selection and displaced tools; `subagents/agent-runner.ts` installs an explicit allowed-tools ceiling. These are directly affected by the host restoration semantics, but no permission leak or broken restoration was demonstrated.

**Next action:** Before accepting 1.4 compatibility, smoke resume and /tree with tools activated/deactivated after session start, a newly installed extension, and explicit codemode disables. Confirm restored branch selections reach the adapter and child ceilings stay closed. Fix reconciliation only if this reveals stale cached selection; do not replace defaultActive:false with broad activation.

<details>
<summary>Classified source entries</summary>

- **1.3.0/05** (line 79; [source](latest.md#130)): **Resumed sessions keep their active tools**: `--tools +name`/`-name` applies on top of them. See [Tools](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/docs/settings.md#tools).
- **1.3.0/11** (line 94; [source](latest.md#130)): Fixed resumed sessions dropping tools activated during the session. Resume now restores the session's active tools, with `--tools +name`/`-name` entries applied to them, unless `--tools` with tool names, `--no-tools`, or `--no-builtin-tools` selects tools explicitly ([#10785](https://github.com/earendil-works/pi/issues/10785))
- **1.4.0/29** (line 56; [source](latest.md#140)): Fixed resumed sessions and `/tree` navigation leaving extension tools inactive when the branch recorded its tools before they were registered, such as tools from extensions installed after the session started. Extension tools the branch never added or removed are now active unless they are registered with `defaultActive: false` ([#11062](https://github.com/earendil-works/pi/issues/11062), [#11075](https://github.com/earendil-works/pi/issues/11075))

</details>

### A3 — Custom-message start migration is already in place

**Upstream:** `before_agent_start` now runs for idle triggerTurn custom messages, has a user/custom union, runs while busy, and preserves handler-added system sections through tool calls.

**Local evidence:** `packages/ext/inline-references/index.ts:135` checks `"prompt" in event` before parsing. `ponytail/index.ts`, `codex-adapter/native-registration.ts`, and `subagents/operations.ts` use shared system-prompt/setup fields and should run for both kinds. `auto-compaction.ts` uses a triggerTurn continuation; subagent mailbox and at-mention persistence use triggerTurn:false. No hook calls sendUserMessage or depends on isIdle() being true.

**Next action:** Keep the existing guard and shared setup. Include an auto-compaction custom continuation plus its first tool call in the 1.4 smoke, checking ponytail/adapter/role prompt sections persist once. No additional union migration is needed; do not make all setup user-only.

<details>
<summary>Classified source entries</summary>

- **1.2.0/05** (line 125; [source](latest.md#120)): **`before_agent_start` for extension-triggered runs**: runs started by `pi.sendMessage(..., { triggerTurn: true })` go through the same setup as prompts. See [Events and concurrency](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/docs/extensions.md#events-and-concurrency).
- **1.2.0/07** (line 130; [source](latest.md#120)): Changed `before_agent_start` to also fire for runs started by `pi.sendMessage(..., { triggerTurn: true })` while idle. `BeforeAgentStartEvent` is now a union on `messageType`: `"user"` events carry `prompt` and `images`, and `"custom"` events carry the starting `message` and no `prompt`. Messages returned by handlers are added to both kinds of run, and pending `deliverAs: "nextTurn"` messages are delivered with the custom-message run. Handlers that should act only on user prompts must check `event.messageType === "user"` ([#10267](https://github.com/earendil-works/pi/issues/10267), [#5581](https://github.com/earendil-works/pi/issues/5581), [#10739](https://github.com/earendil-works/pi/pull/10739) by [@davidbrai](https://github.com/davidbrai))
- **1.2.0/08** (line 131; [source](latest.md#120)): Changed the session to count as busy while a run starts, including during `before_agent_start` handlers: `ctx.isIdle()` is false, `pi.sendMessage()` queues into the starting run instead of starting a second run that failed with "Agent is already processing", `pi.sendUserMessage()` requires `deliverAs`, and an abort requested meanwhile aborts the run once it starts ([#10739](https://github.com/earendil-works/pi/pull/10739) by [@davidbrai](https://github.com/davidbrai))
- **1.2.0/23** (line 155; [source](latest.md#120)): Fixed runs started by `pi.sendMessage(..., { triggerTurn: true })` removing system prompt sections added in `before_agent_start` after their first tool call, which changed the prompt mid-run and broke the provider prompt cache twice per run ([#10267](https://github.com/earendil-works/pi/issues/10267), [#10739](https://github.com/earendil-works/pi/pull/10739) by [@davidbrai](https://github.com/davidbrai))

</details>

## Leverage

### L1 — Let native codemode own worker admission and cancellation

**Upstream:** Native scripts gain bounded output, frozen built-ins, linear output joining, watch/update resilience, prompt cancellation, cross-session live-worker accounting, and a 60-second worker queue in 1.4 (default two; PI_CODEMODE_MAX_WORKERS raises it). Async discovery helpers are labelled correctly and multiple text/console emissions have explicit boundaries.

**Local evidence:** `packages/ext/codex-adapter/index.ts` routes exclusively to `native-registration.ts`, which calls createCodemodeExtension; `subagents/agent-runner.ts` installs native codemode in embedded children. `native-codemode.test.ts` exercises native discovery/execution/usage. Local agent concurrency admission is a different resource limit.

**Next action:** Keep the native runtime; do not restore a local sandbox or worker pool. Smoke parent plus multiple in-process children executing/aborting scripts, including a waiting script. Raise worker capacity only after observing contention; do not delete agent-task admission or authorization limits.

<details>
<summary>Classified source entries</summary>

- **1.4.0/04** (line 22; [source](latest.md#140)): **Codemode waits for a free worker**: parallel scripts and in-process subagents queue instead of failing, and `PI_CODEMODE_MAX_WORKERS` raises the limit. See [Codemode limits](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/codemode.md#limits).
- **1.4.0/25** (line 52; [source](latest.md#140)): Fixed codemode scripts failing immediately when both codemode workers are busy, for example with parallel codemode calls or in-process subagents. Scripts now wait up to 60 seconds for a free worker, and `PI_CODEMODE_MAX_WORKERS` raises the limit of two workers ([#11184](https://github.com/earendil-works/pi/issues/11184))
- **1.3.0/12** (line 95; [source](latest.md#130)): Fixed stopping a codemode script or reaching its deadline waiting for a non-interruptible built-in to return on Bun ([#10748](https://github.com/earendil-works/pi/issues/10748))
- **1.3.0/13** (line 96; [source](latest.md#130)): Fixed repeated codemode timeouts or aborts accumulating surviving workers; admission now limits live workers to two across sessions, counting cancelled workers until actual exit ([#10748](https://github.com/earendil-works/pi/issues/10748))
- **1.2.0/24** (line 156; [source](latest.md#120)): Fixed codemode blocking the process for seconds to minutes after scripts with many `text()` calls; joining the output items was quadratic ([#10678](https://github.com/earendil-works/pi/issues/10678))
- **1.2.0/41** (line 173; [source](latest.md#120)): Fixed codemode failing with a broken bridge error when Pi runs under `node --watch` on Node 24 or 26 ([#10725](https://github.com/earendil-works/pi/issues/10725))
- **1.0.3/09** (line 279; [source](latest.md#103)): Fixed codemode failing for the rest of a session after a pnpm global update removed the running install, and added a restart hint when errors occur after pi was updated or removed on disk ([#10439](https://github.com/earendil-works/pi/issues/10439))
- **1.0.4/12** (line 253; [source](latest.md#104)): Fixed codemode scripts that patch built-ins (for example `Array.prototype.toJSON = ...`) crashing pi and leaving the tool call unsettled. Built-ins are now frozen before the script runs, so such patches have no effect ([#10444](https://github.com/earendil-works/pi/issues/10444))
- **1.0.1/16** (line 320; [source](latest.md#101)): Fixed a `codemode` script that prints in a loop crashing pi by running out of memory: a script fails once its output passes 16 Mi characters or 100000 items ([#10283](https://github.com/earendil-works/pi/issues/10283))
- **1.1.0/21** (line 213; [source](latest.md#110)): Fixed the codemode description not marking `searchTools()`, `describeTool()`, and `describeNamespace()` as async, which led models to serialize the unawaited promise as `{}` ([#10555](https://github.com/earendil-works/pi/issues/10555))
- **1.1.0/22** (line 214; [source](latest.md#110)): Fixed codemode output items running together, so models could not tell where one `text()` or `console.log()` output ended and the next began. With several text items, each now starts with a `==> text N/M <==` line, and `console` calls follow the other output in one `<console_output>` block with one line per call

</details>

### L2 — Use recorded execution time rather than a second clock

**Upstream:** Final tool events/render contexts carry recorded durationMs; restored bash rows retain Took; native codemode now shows elapsed/final time.

**Local evidence:** `packages/ext/codex-adapter/native-rendering.ts:151` computes Date.now() minus startedAt on tool_execution_end and persists it in display snapshots. Its renderCall spreads the enclosing render context without assigning the nested duration. `tools.ts` delegates built-in bash rendering. Test contexts already include durationMs/outputPad.

**Next action:** Prefer event.durationMs (with a fallback only if retaining older-host support) for final nested timing and pass each child’s duration when constructing its render context; retain a live-time mechanism only for genuinely running calls. Add a regression with a wall-clock jump and restore the saved snapshot. Inherit native top-level codemode timing instead of duplicating its timer.

<details>
<summary>Classified source entries</summary>

- **1.1.0/07** (line 193; [source](latest.md#110)): Added `durationMs` to the tool render context and to `tool_execution_end` extension events: the recorded execution time of a final tool result ([#10549](https://github.com/earendil-works/pi/issues/10549))
- **1.1.0/17** (line 209; [source](latest.md#110)): Fixed bash and PowerShell results losing `Took` after reloading a session, and the live `Took` including wall-clock steps; both now show the recorded execution time ([#10549](https://github.com/earendil-works/pi/issues/10549))
- **1.2.0/04** (line 124; [source](latest.md#120)): **Codemode improvements**: tool declarations show input constraints such as integer, minimum/maximum, and default, and codemode rows show elapsed and total time. See [Codemode](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/docs/codemode.md).
- **1.2.0/14** (line 140; [source](latest.md#120)): Added elapsed time while a codemode script runs and its total time once finished to the codemode tool row, like bash rows ([#10708](https://github.com/earendil-works/pi/issues/10708))

</details>

### L3 — Inherit summary and context-window fixes

**Upstream:** Summaries omit thinking and use model output limits; reserveTokens only triggers compaction, split-turn instructions survive, context estimation is more conservative, and Codex Sol has a 500K window.

**Local evidence:** `packages/ext/auto-compaction.ts` uses getContextUsage/contextWindow and a capped configured threshold, ctx.compact, and an SDK-child prepareNextTurnWithContext hook into private \_runAutoCompaction. It does not call generateSummary or serializeConversation. E2E settings in `subagents/test/subagent-messages-e2e.test.ts` set reserveTokens to trigger compaction, not cap summaries.

**Next action:** Keep local thresholds and cancellation controls. Do not remove the custom compaction policy merely because summary output caps are fixed. Smoke the private SDK seam and post-compaction continuation on 1.4, with a small model limit and custom instructions; reinterpret reserveTokens only in user documentation if describing it as an output budget.

<details>
<summary>Classified source entries</summary>

- **1.4.0/03** (line 21; [source](latest.md#140)): **Summaries without a fixed output cap**: compaction and branch summaries use the model's output limit, so long reasoning no longer makes them fail. See [Compaction](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/compaction.md#compaction).
- **1.4.0/12** (line 36; [source](latest.md#140)): `generateSummary()` and `generateSummaryWithUsage()` now ignore their `reserveTokens` parameter. Summary requests use the model's output limit instead.
- **1.4.0/18** (line 45; [source](latest.md#140)): Fixed compaction and branch summaries failing with "generation hit the token cap" when reasoning used most of the fixed summary output limit. Summaries now use the model's output limit, and `compaction.reserveTokens` only controls when compaction starts ([#9512](https://github.com/earendil-works/pi/issues/9512), [#9075](https://github.com/earendil-works/pi/issues/9075)).
- **1.4.0/28** (line 55; [source](latest.md#140)): Fixed `/compact <instructions>` ignoring the instructions when summarizing the start of a turn that compaction splits. When the split turn was the only new content since the last compaction, the instructions were ignored entirely ([#11058](https://github.com/earendil-works/pi/issues/11058))
- **1.2.0/18** (line 147; [source](latest.md#120)): Changed `serializeConversation()` (compaction, branch summaries, bug reports) to omit thinking blocks; replayed thinking is often not in the live context, so including it could make a summarization request larger than the context it summarizes and fail
- **1.1.0/34** (line 226; [source](latest.md#110)): Reduced context-limit request failures by estimating input at 3.5 characters per token instead of 4 when calculating output limits ([#10497](https://github.com/earendil-works/pi/issues/10497))
- **1.3.0/29** (line 112; [source](latest.md#130)): Fixed `openai-codex/gpt-6.1-sol` using a 272K context window instead of the 500K window Codex now provides ([#10840](https://github.com/earendil-works/pi/issues/10840))

</details>

### L4 — Preserve native loadout metadata and declaration semantics

**Upstream:** reachesTools coordinates MCP readiness, namespace aliases improve discovery, declarations expose schema constraints and complete MCP result types, non-object structuredContent is allowed, misplaced @options fails early, and schema-valued failures may resolve instead of rejecting. Hidden-tool prompt rules/guidelines are fixed.

**Local evidence:** `packages/ext/codex-adapter/native-registration.ts` spreads the native definition before decorating prepareLoadout, retaining reachesTools; forwards prepareLoadout unchanged and supplies owned outputSchema/structuredContent/isError. `shellValue` intentionally returns nonzero exits as values. `tools.ts` preserves read/bash definitions and supplies custom edit guidance; `native-codemode.test.ts` checks hidden/model-only isolation.

**Next action:** Keep native metadata forwarding and failure checks (inspect exit_code/isError, not only catch). No new reachesTools wrapper is needed. If adding custom discovery, use native namespace aliases and prompt-guideline APIs rather than duplicating declarations. Do not assume all structured results are objects.

<details>
<summary>Classified source entries</summary>

- **1.2.0/10** (line 136; [source](latest.md#120)): Added `reachesTools` to tool definitions, so tools that reach other tools (such as `codemode` and `tool_search`) declare which tools a call may reach; the MCP extension uses it to wait for the servers a call needs and to decide whether a replacement `codemode` or `tool_search` tool can reach MCP tools
- **1.2.0/11** (line 137; [source](latest.md#120)): Added `aliases` to tool namespaces; codemode's `describeNamespace()` and the `namespace` option of `searchTools()` match them, and MCP namespaces use the server name
- **1.2.0/16** (line 145; [source](latest.md#120)): Changed codemode tool declarations to show input constraints such as integer, minimum/maximum, length, pattern, and default as `@` tags on property comments, so scripts see them without the tool repeating them in descriptions ([#10707](https://github.com/earendil-works/pi/issues/10707))
- **1.2.0/17** (line 146; [source](latest.md#120)): Changed codemode declarations of MCP tools to spell out the result type (`content`, `structuredContent`, `isError`) instead of referring to `CallToolResult<T>`, which `describeTool()`, `searchTools()`, and `ALL_TOOLS` showed without defining it; the codemode description no longer includes the shared MCP types
- **1.2.0/19** (line 151; [source](latest.md#120)): Fixed codemode ignoring a `// @options:` line that is not the first line of the script, which ran the script without the requested `timeout_ms`; the call now fails with an error before the script runs ([#10631](https://github.com/earendil-works/pi/issues/10631))
- **1.2.0/22** (line 154; [source](latest.md#120)): Fixed the code mode tool description claiming every failed tool call rejects; a tool that declares an output schema resolves with its value on failure too (e.g. `bash` with a nonzero exit)
- **1.2.0/29** (line 161; [source](latest.md#120)): Fixed MCP tool calls failing when the server returns structured content that is not an object (an array, `null`, or a primitive, as MCP 2026-07-28 allows); codemode declarations of MCP tools without an output schema now type `structuredContent` as `unknown` instead of an object ([#10416](https://github.com/earendil-works/pi/issues/10416))
- **1.0.4/10** (line 251; [source](latest.md#104)): Fixed system prompt rules and the skills hint naming tools hidden by `prepareLoadout`. Hidden tools are left out of the rules, the skills hint names no tool when the file reader is hidden, and `codemode` shows each tool's prompt guidelines with its declaration; `ToolLoadout` gains `getPromptGuidelines()` ([#10343](https://github.com/earendil-works/pi/issues/10343))

</details>

### L5 — Dynamic tools and model changes keep cleaner provider context

**Upstream:** Anthropic inline tool changes, Bedrock signatures, GPT-6 thinking changes, deferred Responses loads, and cross-model thinking conversion/cache behavior are corrected.

**Local evidence:** `packages/ext/codex-adapter/native-registration.ts` re-registers exposure changes and updates active tools; `cache-debug/index.ts` fingerprints actual requests; `subagents/fork-history.ts` and `automode/history.ts` preserve history for host conversion. No local provider message converter implements these fixes.

**Next action:** Inherit provider behavior. Use cache-debug for a model/thinking switch and deferred load after removal; do not pre-strip all persisted thinking or replace dynamic registration with custom cache manipulation.

<details>
<summary>Classified source entries</summary>

- **1.0.1/13** (line 314; [source](latest.md#101)): Anthropic tools added or redefined mid-conversation are now defined inline in the conversation, so redefining a tool under the same name keeps the prompt cache instead of resending the full tool list.
- **1.0.1/24** (line 328; [source](latest.md#101)): Fixed Amazon Bedrock Claude requests failing with "Invalid `signature` in `thinking` block" after the system prompt or tools changed ([#10324](https://github.com/earendil-works/pi/issues/10324))
- **1.3.0/02** (line 76; [source](latest.md#130)): **Cache-preserving thinking level changes on OpenAI GPT-6**: changing the thinking level mid-session with an API key keeps the prompt cache.
- **1.3.0/04** (line 78; [source](latest.md#130)): **Clean model switching**: thinking from a previous model is dropped instead of being shown to the new model as text.
- **1.3.0/06** (line 83; [source](latest.md#130)): Changing the thinking level mid-session on OpenAI GPT-6 models (API key) now keeps the prompt cache ([#10853](https://github.com/earendil-works/pi/issues/10853))
- **1.3.0/09** (line 89; [source](latest.md#130)): Changed model switching to drop thinking blocks from earlier assistant messages produced by a different model, instead of sending them as plain text. The new model previously saw the old model's reasoning as part of its replies and could start writing its own reasoning into the visible answer ([#10995](https://github.com/earendil-works/pi/issues/10995))
- **1.3.0/26** (line 109; [source](latest.md#130)): Fixed OpenAI-compatible responses showing thinking after the answer when a proxy such as LiteLLM sends reasoning and content in the same stream chunk ([#10926](https://github.com/earendil-works/pi/issues/10926))
- **1.4.0/38** (line 65; [source](latest.md#140)): Fixed OpenAI Responses models losing the prompt cache on every deferred tool load after a tool was removed ([#10940](https://github.com/earendil-works/pi/issues/10940))

</details>

### L6 — Keep host parsing, recovery, and built-in execution fixes

**Upstream:** Read range labels, invalid Unicode/final JSON validation, error-result images, orphan tool-result recovery, whitespace-only output, Anthropic strict-schema fallback, and grep’s rg --no-config are fixed.

**Local evidence:** `packages/ext/tools.ts` inherits read execution/call rendering and bash definitions while retaining a custom edit schema. `native-registration.ts` delegates script invocation to Pi, keeps explicit Value.Check and shell error semantics; view-image returns image content. No local grep override or rg-spawning search implementation exists; `file-search/index.ts` uses FFF (policy.ts merely recognizes user shell commands).

**Next action:** Run existing tools/native-codemode tests on the new dependency version and smoke whitespace-only shell output and malformed final arguments. Keep trust-boundary validation. Do not rewrite the custom old_string/new_string edit contract, or add --no-config to arbitrary user-issued rg commands.

<details>
<summary>Classified source entries</summary>

- **1.3.0/15** (line 98; [source](latest.md#130)): Fixed `read` line-range labels for numeric-string or null arguments in the TUI, session tree, HTML exports, and examples ([#9887](https://github.com/earendil-works/pi/issues/9887))
- **1.3.0/20** (line 103; [source](latest.md#130)): Fixed tool-call argument parsing dropping fields when a string contains an invalid `\u` escape such as `\usepackage` ([#10868](https://github.com/earendil-works/pi/issues/10868))
- **1.3.0/21** (line 104; [source](latest.md#130)): Fixed Anthropic and Bedrock Claude requests failing with a 400 when an error tool result contains images; the images are now sent after the tool results of the turn, so the model still sees them ([#10794](https://github.com/earendil-works/pi/issues/10794))
- **1.3.0/30** (line 113; [source](latest.md#130)): Fixed tool calls whose final arguments are malformed JSON silently running with only the fields parsed before the error; they now fail validation and show the model the raw arguments it sent ([#10897](https://github.com/earendil-works/pi/issues/10897))
- **1.4.0/30** (line 57; [source](latest.md#140)): Fixed sessions breaking after recovery from a response cut off at the output limit: the truncated tool call was omitted but its tool results were kept, so providers rejected every later request ([#11227](https://github.com/earendil-works/pi/issues/11227), [#11233](https://github.com/earendil-works/pi/pull/11233) by [@petrroll](https://github.com/petrroll))
- **1.4.0/31** (line 58; [source](latest.md#140)): Fixed the `grep` tool following `RIPGREP_CONFIG_PATH`, where options such as `--fixed-strings` silently changed regex searches into literal ones. The tool now runs `rg --no-config` ([#11203](https://github.com/earendil-works/pi/issues/11203), [#11230](https://github.com/earendil-works/pi/pull/11230) by [@petrroll](https://github.com/petrroll))
- **1.4.0/36** (line 63; [source](latest.md#140)): Fixed whitespace-only tool output (for example a bare `\r\n` from bash) making OpenAI Completions, OpenAI Responses, and Google requests fail with a 400 ([#8720](https://github.com/earendil-works/pi/issues/8720))
- **1.2.0/32** (line 164; [source](latest.md#120)): Fixed Anthropic requests failing when the provider rejects the strict tool set for grammar size, tool count, or union limits; Pi now retries once with preferred tools non-strict ([#10409](https://github.com/earendil-works/pi/issues/10409))

</details>

### L7 — Inherit dialog ownership and stacking fixes

**Upstream:** Overlay done() closes its own overlay, inline dialogs stack without stranded promises, and focused overlays no longer block transcript mouse-wheel scrolling.

**Local evidence:** `packages/ext/bash-gate/approval.ts` and `automode-escalation.ts` open select dialogs; `context.ts` and `usage-dashboard.ts` open custom components; `session-tracker/index.ts` offers a selector. No local stack replacement is present.

**Next action:** Smoke overlapping approval/viewer/selector dialogs and cancellation on the installed 1.4 host. Rely on host ownership; keep local abort/session safety rather than adding an extension-global dialog queue.

<details>
<summary>Classified source entries</summary>

- **1.3.0/32** (line 115; [source](latest.md#130)): Fixed `done()` of an extension's `ctx.ui.custom({ overlay: true })` closing the topmost overlay instead of its own, which left the finished overlay on screen and another extension's dialog unresolved ([#10648](https://github.com/earendil-works/pi/issues/10648), [#10999](https://github.com/earendil-works/pi/pull/10999) by [@masonc15](https://github.com/masonc15))
- **1.4.0/23** (line 50; [source](latest.md#140)): Fixed concurrent extension `select`/`confirm`/`input`/`editor` dialogs and inline `custom()` components in interactive mode: a second dialog replaced the first and the first promise never settled; closing the visible dialog now shows the previous one again ([#11166](https://github.com/earendil-works/pi/issues/11166), [#9909](https://github.com/earendil-works/pi/issues/9909))
- **1.2.0/34** (line 166; [source](latest.md#120)): Fixed focused fullscreen overlays blocking mouse-wheel scrolling of the transcript ([#10769](https://github.com/earendil-works/pi/issues/10769))

</details>

### L8 — Reuse native image persistence and private output files

**Upstream:** image() saves files and reports their paths, read images reach scripts, and host output artifacts are user-readable only.

**Local evidence:** `packages/ext/codex-adapter/view-image/tool.ts` returns image blocks; `native-registration.ts` supplies an image-valued structured result; `native-rendering.ts` leaves original result.content intact and delegates native output rendering/full-output links. No local image artifact store is needed.

**Next action:** Keep image blocks and native full-output paths intact; smoke showing an image and accessing the saved path later. The host file-permission change does not automatically secure artifacts created by local native helpers; do not claim it does.

<details>
<summary>Classified source entries</summary>

- **1.0.3/02** (line 260; [source](latest.md#103)): **Codemode images saved to files** — `image()` also writes each image to a temp file and names the path in the result, so later turns can copy or move generated images. See [Generate images](https://github.com/earendil-works/pi/blob/v1.0.3/packages/coding-agent/docs/codemode.md#generate-images).
- **1.0.3/05** (line 272; [source](latest.md#103)): Codemode `image()` now also saves each image to a temp file and names the path in the result, so later turns can copy or move generated images ([#10310](https://github.com/earendil-works/pi/issues/10310))
- **1.0.3/06** (line 273; [source](latest.md#103)): Output files (full text of truncated tool output, binary MCP resources, codemode images) are now readable only by the user
- **1.0.4/02** (line 237; [source](latest.md#104)): **Codemode persists images**: `tools.read()` on an image file now gives back an image block that `image()` can show. See [Call tools](https://github.com/earendil-works/pi/blob/v1.0.4/packages/coding-agent/docs/codemode.md#call-tools).
- **1.0.4/06** (line 247; [source](latest.md#104)): Fixed codemode scripts not receiving images from `read`: `tools.read()` now resolves to an image block for image files, which `image()` shows ([#10251](https://github.com/earendil-works/pi/issues/10251))

</details>

### L9 — Usage displays inherit upstream price corrections

**Upstream:** Long-context pricing tiers are counted correctly across providers and negative OpenRouter placeholder prices become zero.

**Local evidence:** `packages/ext/usage-files.ts` and `usage-dashboard-data.ts` consume persisted usage.cost.total rather than own a provider pricing catalog. `token-count/index.ts` separately queries subscription entitlements, not per-token prices.

**Next action:** Inherit corrected costs for new requests. Do not rewrite historic recorded costs or assume these fixes repair subscription usage endpoints.

<details>
<summary>Classified source entries</summary>

- **1.0.1/23** (line 327; [source](latest.md#101)): Fixed Amazon Bedrock OpenAI models costing requests above 272k input tokens at the short-context rate; Bedrock models now include the pricing tiers listed on models.dev ([#10326](https://github.com/earendil-works/pi/issues/10326))
- **1.1.0/37** (line 229; [source](latest.md#110)): Fixed session costs undercounting long prompts on models with prompt-length pricing tiers, such as Claude Haiku 5.5, Gemini 3.1 Pro, and GPT-5.4, through OpenCode, OpenCode Go, OpenRouter, Vercel AI Gateway, Google, MiniMax, and other providers
- **1.2.0/31** (line 163; [source](latest.md#120)): Fixed OpenRouter router models such as `openrouter/auto` showing a cost of -$1,000,000 per 1M tokens; OpenRouter's negative placeholder prices are now 0 ([#10672](https://github.com/earendil-works/pi/pull/10672) by [@davidbrai](https://github.com/davidbrai))

</details>

### L10 — Keep retry and provider recovery in the host

**Upstream:** Capacity/gateway/Mistral/Bedrock/Vertex failures retry more accurately; long Mistral thinking no longer hits a stream timeout; Copilot 413 compacts/retries; ChatGPT Business usage caps fail with an admin instruction rather than retrying.

**Local evidence:** `subagents/agent-runner.ts` runs AgentSession and observes retry/compaction lifecycle; `agent-manager.ts` records failures. `token-count/index.ts` and web_run have independent HTTP paths; Pi provider retries do not cover these requests.

**Next action:** Keep host retry behavior and existing lifetime tracking. Confirm retry/compaction does not release agent capacity early. Do not add blanket retries around mutable tools, approval failures, or Business workspace limits; do not delete local HTTP timeouts on the assumption Pi now owns them.

<details>
<summary>Classified source entries</summary>

- **1.0.1/20** (line 324; [source](latest.md#101)): Fixed "Selected model is at capacity" provider errors ending the turn instead of being retried ([#10278](https://github.com/earendil-works/pi/issues/10278))
- **1.0.4/11** (line 252; [source](latest.md#104)): Fixed Bedrock requests that fail with `The pending stream has been canceled` after a stalled HTTP/2 connection not being retried automatically ([#10379](https://github.com/earendil-works/pi/issues/10379))
- **1.1.0/32** (line 224; [source](latest.md#110)): Fixed `server_busy` and `servers are currently busy` provider errors ending the turn instead of being retried ([#10543](https://github.com/earendil-works/pi/issues/10543))
- **1.1.0/33** (line 225; [source](latest.md#110)): Fixed Mistral responses that end with `finish_reason: "error"` not being retried ([#10487](https://github.com/earendil-works/pi/issues/10487))
- **1.2.0/20** (line 152; [source](latest.md#120)): Fixed Mistral streams being aborted mid-generation (e.g. during long thinking) after the request timeout; the timeout now applies only to waiting for response headers ([#10609](https://github.com/earendil-works/pi/issues/10609))
- **1.2.0/33** (line 165; [source](latest.md#120)): Fixed "The upstream provider returned an error" not being retried as a transient provider error ([#10842](https://github.com/earendil-works/pi/issues/10842))
- **1.3.0/24** (line 107; [source](latest.md#130)): Fixed automatic retry not triggering for gateway `Unable to forward upstream stream` errors ([#10920](https://github.com/earendil-works/pi/issues/10920))
- **1.3.0/25** (line 108; [source](latest.md#130)): Fixed automatic retry not triggering for `The service is temporarily unavailable` errors, which also made compaction fail on the first attempt ([#10965](https://github.com/earendil-works/pi/issues/10965))
- **1.4.0/17** (line 41; [source](latest.md#140)): Sign in with ChatGPT: ChatGPT Business workspace usage-limit errors are not retried and tell the user to ask their workspace admin to increase the limit.
- **1.4.0/34** (line 61; [source](latest.md#140)): Fixed GitHub Copilot sessions with large request bodies, such as many images, failing with HTTP 413 `failed to parse request` instead of compacting and retrying ([#11016](https://github.com/earendil-works/pi/pull/11016) by [@petrroll](https://github.com/petrroll))
- **1.4.0/37** (line 64; [source](latest.md#140)): Fixed automatic retry not triggering for more gateway upstream failures, `stream disconnected before completion` errors relayed by Codex CLI proxies, and transient Google Vertex OAuth token refresh failures, and retrying errors because of digits inside request ids or byte counts ([#10920](https://github.com/earendil-works/pi/issues/10920), [#11057](https://github.com/earendil-works/pi/issues/11057), [#10996](https://github.com/earendil-works/pi/issues/10996))

</details>

### L11 — Distinguish cancelled settlement from completion

**Upstream:** agent_settled now includes aborted, including cancellations not represented by the last assistant message.

**Local evidence:** `packages/ext/subagents/v2-tools.ts:53` discards the event and derives root completion from agent_end stopReason. `session-tracker/index.ts:717` also discards it before needs-input classification. `agent-manager.ts` releases execution slots for every settlement; `auto-compaction.ts` deliberately aborts before resuming after compaction.

**Next action:** Use event.aborted when choosing root interrupted/completed status, and decide whether cancelled partial text should trigger needs-input. Add a cancellation-during-startup/compaction regression. Keep unconditional capacity release and preserve intentional auto-compaction continuation; aborted is not a reason to skip all settlement cleanup.

<details>
<summary>Classified source entries</summary>

- **1.1.0/12** (line 198; [source](latest.md#110)): Added `aborted` to `agent_settled` session, extension, and JSON events, so integrations can tell a cancelled run from a finished one ([#10607](https://github.com/earendil-works/pi/issues/10607))

</details>

## Watch

### W1 — Provider renames and header ownership are conditional migrations

**Upstream:** Azure’s provider becomes azure (Responses API spelling is separate); Kimi Code uses Chat Completions with /v1 in base overrides; attribution headers move to pi-ai client identity; Codex model-header overrides now work.

**Local evidence:** `packages/ext/codex-adapter/activation.ts` already accepts azure prefixes. The remaining azure-openai-responses in `web-run/tool.ts:17` is an API discriminator, not a provider key to rename. No tracked Azure/Kimi models/auth/settings configuration or before_provider_headers hook was found. web_run builds its own request headers with registry auth and model overrides.

**Next action:** No local provider rename is needed. Users with old Azure auth/settings must migrate privately; Kimi base overrides must include /v1. If adding a provider-header hook, do not expect attribution headers in its input; use null to suppress. Preserve web_run’s separate endpoint/credential validation.

<details>
<summary>Classified source entries</summary>

- **1.0.3/01** (line 259; [source](latest.md#103)): **Azure Foundry Chat Completions** — The `azure` provider (renamed from `azure-openai-responses`) now also serves Foundry Chat Completions deployments, starting with `azure/deepseek-v4-pro`. See [Azure OpenAI](https://github.com/earendil-works/pi/blob/v1.0.3/packages/coding-agent/docs/providers.md#azure-openai).
- **1.0.3/03** (line 264; [source](latest.md#103)): Renamed the Azure provider from `azure-openai-responses` to `azure`. Rename the provider key in `auth.json` (or run `/login` again), in `models.json`, and in `settings.json` (`defaultProvider`, `enabledModels` patterns, and `modelThinkingLevels` keys). Sessions that used the old provider fall back to another model when resumed, and their prompt cache is not reused. The `AZURE_OPENAI_*` environment variables are unchanged ([#9714](https://github.com/earendil-works/pi/pull/9714) by [@jsanter27](https://github.com/jsanter27))
- **1.0.3/04** (line 268; [source](latest.md#103)): Added Azure Foundry Chat Completions deployments, starting with `azure/deepseek-v4-pro` ([#9645](https://github.com/earendil-works/pi/issues/9645), [#9714](https://github.com/earendil-works/pi/pull/9714) by [@jsanter27](https://github.com/jsanter27))
- **1.3.0/03** (line 77; [source](latest.md#130)): **Kimi Code over Chat Completions**: tools added mid-conversation no longer invalidate the prompt cache. `models.json` base URL overrides must now include `/v1`. See [Providers](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/docs/providers.md).
- **1.3.0/08** (line 88; [source](latest.md#130)): Changed the `kimi-coding` provider to use OpenAI Chat Completions at `https://api.kimi.com/coding/v1`, the protocol used by the official Kimi Code client. K3, K3-256K, and Kimi For Coding now accept tools added mid-conversation without invalidating the prompt cache. `models.json` overrides of the `kimi-coding` base URL must now include `/v1` ([#10720](https://github.com/earendil-works/pi/issues/10720))
- **1.4.0/11** (line 35; [source](latest.md#140)): Provider attribution headers now come from pi-ai's client identity. Extensions' `before_provider_headers` handlers no longer see the OpenRouter, NVIDIA NIM, and OpenCode attribution headers; returning `null` for one still removes it. Cloudflare requests send pi's detailed `User-Agent` instead of `pi-coding-agent`, as do GitHub release checks for tool downloads, and OpenCode requests send `x-opencode-client` whenever attribution is enabled, not only with a session.
- **1.1.0/31** (line 223; [source](latest.md#110)): Fixed model `headers` in `models.json` not overriding the `originator` and `User-Agent` headers of Codex requests ([#10429](https://github.com/earendil-works/pi/pull/10429) by [@lucasmeijer](https://github.com/lucasmeijer))

</details>

### W2 — Catalog and ambiguity changes flow through runtime model resolution

**Upstream:** New/retired models, default models, supported thinking levels, OpenCode API routing, authenticated OpenRouter catalogs, and CLI ambiguous model selection change across these releases; trailing commas no longer add a spurious model.

**Local evidence:** `packages/ext/shared/model-resolver.ts` implements local fuzzy and exact resolution; exact resolution rejects multiple matching bare IDs. `subagents/native-model-scope.ts` uses the runtime registry. `small-model.ts` pins github-copilot/claude-haiku-4.5, not the new Haiku 5.5; the new Copilot default Sol matches `activation.ts`. No listed retired NVIDIA/Xiaomi/Codex model is a production default here.

**Next action:** Use qualified provider/model IDs in roles and config, re-resolve after catalog refresh, and smoke thinking levels. Do not assume CLI ambiguity fixes alter local fuzzy fallback, silently upgrade the small-model default, or treat a new per-key catalog as an availability regression.

<details>
<summary>Classified source entries</summary>

- **1.0.1/15** (line 319; [source](latest.md#101)): Fixed a trailing comma in `--models` adding an extra model to the model cycle ([#10334](https://github.com/earendil-works/pi/issues/10334))
- **1.0.1/21** (line 325; [source](latest.md#101)): Fixed Cloudflare AI Gateway Claude models failing with a 404 by using dashed model IDs (`claude-opus-5-5` instead of `claude-opus-5.5`)
- **1.0.1/25** (line 329; [source](latest.md#101)): Fixed Together DeepSeek V4 Pro losing its thinking level controls after Together renamed it to `deepseek-ai/DeepSeek-V4-Pro-0813` ([#10336](https://github.com/earendil-works/pi/pull/10336) by [@cv](https://github.com/cv))
- **1.0.1/26** (line 330; [source](latest.md#101)): Fixed the default NVIDIA model pointing at `nvidia/nemotron-3-super-120b-a12b`, which NVIDIA no longer serves; the default is now `nvidia/nemotron-3-ultra-550b-a55b`
- **1.1.0/02** (line 185; [source](latest.md#110)): **Claude Haiku 5.5**: `anthropic/claude-haiku-5-5`, with adaptive thinking up to `xhigh`/`max` effort.
- **1.1.0/13** (line 199; [source](latest.md#110)): Added Claude Haiku 5.5 (`anthropic/claude-haiku-5-5`), with adaptive thinking up to `xhigh`/`max` effort and prompt caching on Bedrock
- **1.1.0/30** (line 222; [source](latest.md#110)): Fixed OpenAI models on Bedrock ignoring the thinking level and always running at Bedrock's default reasoning effort ([#9331](https://github.com/earendil-works/pi/issues/9331), [#10142](https://github.com/earendil-works/pi/pull/10142) by [@jsanter27](https://github.com/jsanter27))
- **1.1.0/35** (line 227; [source](latest.md#110)): Fixed Radius models disabled by an organization owner still being listed
- **1.2.0/01** (line 121; [source](latest.md#120)): **Per-key OpenRouter model lists**: with an OpenRouter key, Pi lists only the models that key may use, with the key's context size, max output, and prices, including regional endpoints set in `models.json`. See [OpenRouter](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/docs/providers.md#openrouter).
- **1.2.0/12** (line 138; [source](latest.md#120)): Added per-key OpenRouter model lists: with an OpenRouter key, Pi lists only the chat models that key may use, with the key's context size, max output, and prices, including guardrails and regional endpoints set as the base URL in `models.json`. The list is saved and used offline ([#10353](https://github.com/earendil-works/pi/issues/10353), [#10672](https://github.com/earendil-works/pi/pull/10672) by [@davidbrai](https://github.com/davidbrai))
- **1.3.0/14** (line 97; [source](latest.md#130)): Fixed `--model` choosing a provider by catalog order when several providers offer the match; Pi now prefers the provider with credentials and otherwise reports the ambiguity. `--models` and `enabledModels` add a model for each provider that offers it and warn about the ambiguity ([#10160](https://github.com/earendil-works/pi/issues/10160))
- **1.3.0/22** (line 105; [source](latest.md#130)): Fixed OpenCode Go Gemini models failing with a 404 by moving OpenCode Zen and OpenCode Go to the `opencode.ai/inference` endpoints, and added Google Generative AI support to the OpenCode Go provider
- **1.3.0/23** (line 106; [source](latest.md#130)): Fixed OpenCode Go MiniMax M2.7 failing with "Model does not support this protocol" by using the Anthropic Messages API
- **1.3.0/27** (line 110; [source](latest.md#130)): Fixed Gemini 4 Argon requests on Google Vertex failing with "Thinking budget is not supported", and its thinking level being ignored on the Gemini API ([#10890](https://github.com/earendil-works/pi/issues/10890))
- **1.3.0/28** (line 111; [source](latest.md#130)): Fixed Xiaomi MiMo models failing with a 400 at the `minimal` thinking level; they now expose only the `off` and `high` levels ([#10818](https://github.com/earendil-works/pi/issues/10818))
- **1.3.0/31** (line 114; [source](latest.md#130)): Fixed Claude Haiku 5.5 and Claude Opus 5 not supporting the `off` thinking level ([#10753](https://github.com/earendil-works/pi/issues/10753))
- **1.4.0/09** (line 30; [source](latest.md#140)): Added `MiniMax-M3.1-Flash` to the `minimax` and `minimax-cn` providers, with thinking levels low through max ([#11121](https://github.com/earendil-works/pi/issues/11121))
- **1.4.0/13** (line 37; [source](latest.md#140)): Changed the default GitHub Copilot model from `gpt-5.4`, which Copilot retired, to `gpt-6.1-sol`.
- **1.4.0/14** (line 38; [source](latest.md#140)): Changed the default NVIDIA model to `nvidia/nemotron-3.5-super-vl-120b-a12b` ([#10910](https://github.com/earendil-works/pi/pull/10910) by [@cv](https://github.com/cv))
- **1.4.0/15** (line 39; [source](latest.md#140)): Changed the default Xiaomi model to `mimo-v2.6-pro` for the `xiaomi` and Xiaomi Token Plan providers, since `mimo-v2.5-pro` left the catalog.
- **1.4.0/16** (line 40; [source](latest.md#140)): Grok 4.3 and Grok 4.5 on the `xai` provider now offer the `xhigh` thinking level.
- **1.4.0/35** (line 62; [source](latest.md#140)): Fixed the `openai-codex` provider offering `gpt-5.5` and `gpt-5.3-codex-spark`, which always fail for ChatGPT accounts ([#11173](https://github.com/earendil-works/pi/pull/11173) by [@lucasmeijer](https://github.com/lucasmeijer))

</details>

### W3 — Classifier additions are optional, not a chat-model replacement

**Upstream:** Clef/Jev/Luna and llama.cpp decision models become classifiers, image input and compat expand, and Workers AI classifier pricing is corrected.

**Local evidence:** `packages/ext/session-tracker/index.ts:129` classifies needs-input through modelRegistry.streamSimple with a chat model and strict two-label parsing; there is no models.classify invocation. Adapter and SDK-child codemode use models:false. AutoMode performs richer evidence-based authorization, not merely an image classifier.

**Next action:** Consider native classifiers only if a concrete cost/latency benchmark justifies a separate model/credential choice. Keep the current chat fallback and independent authorization semantics; do not enable classifier models or change defaults just because they are now available.

<details>
<summary>Classified source entries</summary>

- **1.0.1/05** (line 300; [source](latest.md#101)): **Cloudflare Clef classifiers** — `@cf/cloudflare/clef` and `@cf/cloudflare/clef-flash` are usable from codemode scripts and extensions. See [Use classifier models](https://github.com/earendil-works/pi/blob/v1.0.1/packages/coding-agent/docs/models.md#use-classifier-models).
- **1.0.1/09** (line 307; [source](latest.md#101)): Added Cloudflare's Clef and Clef Flash classifier models to `cloudflare-workers-ai`, usable from codemode scripts and extensions ([#10316](https://github.com/earendil-works/pi/pull/10316) by [@ndisidore](https://github.com/ndisidore), [#10322](https://github.com/earendil-works/pi/pull/10322) by [@RealAlexandreAI](https://github.com/RealAlexandreAI))
- **1.1.0/04** (line 187; [source](latest.md#110)): **GPT-6 Luna and image classification**: OpenAI's GPT-6 Luna is available as a classifier model through the Decisions API, and codemode's `models.classify()` accepts images for classifiers that support them. See [Use classifier models](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/models.md#use-classifier-models).
- **1.1.0/05** (line 188; [source](latest.md#110)): **Native llama.cpp decision models**: Julia-1, Laya, Kev, lev, and OpenJev served by llama.cpp 0.6.0 or later run natively as classifiers through `/v1/systemone`. See [Classification](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/llama-cpp.md#classification).
- **1.1.0/09** (line 195; [source](latest.md#110)): Added OpenAI's GPT-6 Luna as a classifier model through the Decisions API, available with `OPENAI_API_KEY` (see [Use classifier models](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/models.md#use-classifier-models))
- **1.1.0/10** (line 196; [source](latest.md#110)): Added `images` to codemode's `models.classify()` context, so classifiers that accept images, such as GPT-6 Luna, can judge them
- **1.1.0/14** (line 200; [source](latest.md#110)): Added native llama.cpp decision models: Julia-1, Laya, Kev, lev, and OpenJev served by llama.cpp 0.6.0 or later are listed only as classifiers through `/v1/systemone` instead of as chat models (see [Classification](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/llama-cpp.md#classification)) ([#10382](https://github.com/earendil-works/pi/pull/10382))
- **1.4.0/01** (line 19; [source](latest.md#140)): **Image input for classifiers**: codemode `models.classify()` accepts `images` for TypeSafe's Jev and Cloudflare's Clef models on `typesafe`, `cloudflare-workers-ai`, and OpenRouter. See [Use classifier models](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/models.md#use-classifier-models) and [Codemode](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/codemode.md#models).
- **1.4.0/07** (line 28; [source](latest.md#140)): Codemode `models.classify()` now accepts `images` for TypeSafe's Jev and Cloudflare's Clef models on `typesafe`, `cloudflare-workers-ai`, and OpenRouter, and lists Clef Omni and Jev 1.14 on Workers AI.
- **1.4.0/08** (line 29; [source](latest.md#140)): Provider-level `compat` in `models.json` now also applies to classifier models, with the System One fields `imageInput` and `sendImageOptInHeader` for proxies that serve another service's classifiers. Extension classifier models accept `compat` too.
- **1.4.0/39** (line 66; [source](latest.md#140)): Fixed Cloudflare Workers AI classifier pricing: Clef Flash costs $0.038 and Jev $0.042 per million input tokens instead of Jev being listed as free.

</details>

### W4 — CLI tool patterns are not the SDK child permission model

**Upstream:** --tools/--exclude-tools accept wildcards, +/− adjusts defaults, MCP remains selected unless explicitly targeted, and --no-mcp disables native MCP.

**Local evidence:** `package.json` dev explicitly loads builtin codemode/tool-search with -ne and no builtin:mcp. `scripts/native-codemode-cli-smoke.ts` selects codemode in an isolated -ne invocation. `subagents/agent-runner.ts` uses SDK allowedTools and explicit extensionFactories, not CLI wildcard parsing.

**Next action:** Keep development isolation and explicit child ceilings. Use --no-mcp for a full-host CLI smoke that must exclude MCP; do not assume --tools codemode now excludes MCP or translate child allowlists into permissive CLI patterns.

<details>
<summary>Classified source entries</summary>

- **1.0.4/01** (line 236; [source](latest.md#104)): **Tool patterns and `--no-mcp`**: `--tools` and `--exclude-tools` accept `*` patterns, for example `--tools read,codemode,'mcp__radius__*'` keeps only one MCP server's tools. `--tools` now keeps MCP tools unless an entry starts with `mcp__`, and `--no-mcp` turns off MCP for one run. See [Tools](https://github.com/earendil-works/pi/blob/v1.0.4/packages/coding-agent/docs/cli.md#tools) and [MCP tools](https://github.com/earendil-works/pi/blob/v1.0.4/packages/coding-agent/docs/cli.md#mcp-tools).
- **1.0.4/03** (line 241; [source](latest.md#104)): Added `*` patterns to `--tools` and `--exclude-tools`, for example `--tools read,codemode,'mcp__radius__*'`
- **1.0.4/04** (line 242; [source](latest.md#104)): Added `--no-mcp` to disable the built-in MCP support for one run
- **1.0.4/08** (line 249; [source](latest.md#104)): Fixed `--tools` removing MCP tools, which left `pi --tools codemode` without any MCP servers. `--tools` now keeps MCP tools unless an entry starts with `mcp__`
- **1.1.0/03** (line 186; [source](latest.md#110)): **Adjust default tools with `+name`/`-name`**: `--tools` entries like `pi -t +codemode,-write` change the default selection instead of replacing it. See [Tools](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/cli.md#tools).
- **1.1.0/06** (line 192; [source](latest.md#110)): Added `+name` and `-name` entries to `--tools`, which change the default tool selection instead of replacing it, for example `pi -t +codemode`

</details>

### W5 — Native terminal status complements the richer tmux tracker

**Upstream:** OSC 7501 reports working/blocked/done/failed; PI_PROGRAM_STATUS overrides detection.

**Local evidence:** `packages/ext/session-tracker/index.ts` tracks tmux sessions, panes, background agents, and needs-input; `footer/index.ts`/`statusline.ts` add local UI. No local OSC 7501 emitter was found.

**Next action:** Avoid duplicate native status escape emission. Keep tmux and background-agent features; only simplify them if native program status eventually covers those requirements.

<details>
<summary>Classified source entries</summary>

- **1.1.0/01** (line 184; [source](latest.md#110)): **Program status reporting**: terminals and agent dashboards that support OSC 7501 see whether Pi is working, blocked on a dialog or login, done, or failed. See [Program status](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/terminal-setup.md#program-status).
- **1.1.0/11** (line 197; [source](latest.md#110)): Added program status reporting with OSC 7501: terminals and agent dashboards that support it see whether Pi is working, blocked on a dialog or login, done, or failed. `PI_PROGRAM_STATUS=1|0` overrides detection (see [Terminal setup](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/terminal-setup.md#program-status)) ([#10607](https://github.com/earendil-works/pi/issues/10607))

</details>

### W6 — Terminal, Markdown, image, clipboard, and autocomplete behavior

**Upstream:** Rex and other terminal/image compatibility improves; teardown, transcript selection, shell ANSI fragments, Markdown syntax/math/CJK rendering, clipboard handling, shifted-key matches, and regex-metacharacter @ completion are fixed. Home/End now target editor lines; Ctrl+Home/End targets transcript.

**Local evidence:** `packages/ext/file-search/index.ts` uses FFF for workspace queries and falls back to host completion for browsing/unavailable results. `inline-references/index.ts` wraps host autocomplete. `view/index.ts`, `context.ts`, `usage-dashboard.ts`, custom tool renderers, footer, and native image results share the host TUI; none replaces terminal teardown or host clipboard code.

**Next action:** Smoke fallback @ paths containing [ or (, image scrolling, overlapping UI, and both TUI modes on supported terminals. Mention PI_CLIPBOARD_OSC52=1 only when remote/multiplexer copies fail. Do not duplicate terminal detection or claim FFF itself received the host’s regex fix.

<details>
<summary>Classified source entries</summary>

- **1.0.3/07** (line 274; [source](latest.md#103)): `Home`/`End` now always move the editor cursor to the line start/end; fullscreen transcript top/bottom moved to `Ctrl+Home`/`Ctrl+End`, which no longer move the editor cursor ([#10314](https://github.com/earendil-works/pi/issues/10314))
- **1.0.3/10** (line 280; [source](latest.md#103)): Fixed interactive sessions reporting a `read EIO` or `setRawMode EIO` crash (and asking to run /bug) when the terminal went away, e.g. after closing the window or resuming a suspended pi in a closed terminal
- **1.4.0/05** (line 23; [source](latest.md#140)): **Rex terminal support**: OSC 8 hyperlinks, truecolor, and inline images.
- **1.4.0/10** (line 31; [source](latest.md#140)): Added support for the Rex terminal: OSC 8 hyperlinks, truecolor, and inline images ([#11131](https://github.com/earendil-works/pi/issues/11131), [#11150](https://github.com/earendil-works/pi/pull/11150) by [@petrroll](https://github.com/petrroll), [#11183](https://github.com/earendil-works/pi/pull/11183) by [@nihaals](https://github.com/nihaals))
- **1.4.0/21** (line 48; [source](latest.md#140)): Fixed HTML export showing literal asterisks for Markdown bold and italic next to CJK punctuation ([#3353](https://github.com/earendil-works/pi/issues/3353), [#10154](https://github.com/earendil-works/pi/issues/10154))
- **1.4.0/22** (line 49; [source](latest.md#140)): Fixed the terminal staying in mouse-tracking, focus-reporting, Kitty keyboard, and alternate-screen modes when pi exits without its normal terminal teardown, which flooded the shell prompt with escape sequences ([#11170](https://github.com/earendil-works/pi/issues/11170))
- **1.4.0/24** (line 51; [source](latest.md#140)): Fixed pasting in the shell hanging after copying text in pi and suspending it with Ctrl+Z on Linux: the background `wl-copy`/`xclip`/`xsel` process that keeps serving the clipboard was suspended along with pi ([#11179](https://github.com/earendil-works/pi/issues/11179))
- **1.4.0/40** (line 67; [source](latest.md#140)): Fixed an unclosed `$$` display-math block swallowing or corrupting every Markdown table after it ([#11159](https://github.com/earendil-works/pi/issues/11159))
- **1.4.0/41** (line 68; [source](latest.md#140)): Fixed Markdown bold and italic not rendering next to CJK punctuation ([#10730](https://github.com/earendil-works/pi/pull/10730) by [@theBucky](https://github.com/theBucky))
- **1.4.0/42** (line 69; [source](latest.md#140)): Fixed `@` file autocomplete returning no results for queries containing regex metacharacters such as `[` or `(` ([#10972](https://github.com/earendil-works/pi/issues/10972))
- **1.2.0/03** (line 123; [source](latest.md#120)): **Clipboard copies over remote sessions**: `PI_CLIPBOARD_OSC52=1` sends copied text to a remote client's clipboard when Pi cannot detect the remote session, such as a multiplexer attached from another machine. See [Pi Process Configuration](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/docs/environment-variables.md#pi-process-configuration).
- **1.2.0/13** (line 139; [source](latest.md#120)): Added `PI_CLIPBOARD_OSC52=1` to send copied text to the terminal with OSC 52 after the local clipboard write, so copies reach a remote client's clipboard when Pi cannot detect the remote session, such as multiplexer attaches from another machine or remote IDE daemons ([#10826](https://github.com/earendil-works/pi/issues/10826), [#10835](https://github.com/earendil-works/pi/issues/10835), [#10114](https://github.com/earendil-works/pi/issues/10114))
- **1.2.0/15** (line 144; [source](latest.md#120)): Changed the `showHardwareCursor` setting to use only the terminal cursor instead of also drawing Pi's reverse-video cursor
- **1.2.0/35** (line 167; [source](latest.md#120)): Fixed fragmented terminal color replies leaking hex values into the prompt and opening the external editor (related reports: [#10256](https://github.com/earendil-works/pi/issues/10256), [#10657](https://github.com/earendil-works/pi/issues/10657))
- **1.2.0/36** (line 168; [source](latest.md#120)): Fixed inline images not rendering in Herdr since 1.1.0 ([#10774](https://github.com/earendil-works/pi/pull/10774) by [@ogulcancelik](https://github.com/ogulcancelik))
- **1.2.0/37** (line 169; [source](latest.md#120)): Fixed key bindings that name a shifted symbol, such as `+` or `ctrl++`, not matching under the Kitty keyboard protocol or modifyOtherKeys ([#9880](https://github.com/earendil-works/pi/pull/9880) by [@christianklotz](https://github.com/christianklotz))
- **1.1.0/20** (line 212; [source](latest.md#110)): Fixed `!!` command headers losing their dim color once output arrives ([#10557](https://github.com/earendil-works/pi/pull/10557) by [@rwachtler](https://github.com/rwachtler))
- **1.1.0/24** (line 216; [source](latest.md#110)): Fixed images being dropped as "could not be resized" when running under `node --watch` on Node 24.19+ and 26.x, where Node posts its own messages on the image resize worker channel ([#10527](https://github.com/earendil-works/pi/issues/10527))
- **1.1.0/25** (line 217; [source](latest.md#110)): Fixed clipboard paste doing nothing in Termux, and failed copies there omitting the Termux:API install hint ([#10391](https://github.com/earendil-works/pi/issues/10391))
- **1.1.0/26** (line 218; [source](latest.md#110)): Fixed `!` and RPC `bash` output keeping fragments of color codes, such as a stray `m`, when a code was split across output chunks ([#10504](https://github.com/earendil-works/pi/issues/10504))
- **1.1.0/29** (line 221; [source](latest.md#110)): Fixed the fullscreen text selection surviving session switches and other transcript rebuilds, which highlighted unrelated text in the new transcript ([#9311](https://github.com/earendil-works/pi/issues/9311), [#10567](https://github.com/earendil-works/pi/pull/10567) by [@christianklotz](https://github.com/christianklotz))
- **1.1.0/38** (line 230; [source](latest.md#110)): Fixed Markdown links not being clickable in Herdr ([#10573](https://github.com/earendil-works/pi/issues/10573))
- **1.0.1/17** (line 321; [source](latest.md#101)): Fixed JPEG, GIF, and WebP images rendered by extensions through `Image` not appearing in Kitty, Ghostty, WezTerm, and Warp ([#10292](https://github.com/earendil-works/pi/issues/10292))
- **1.0.1/18** (line 322; [source](latest.md#101)): Fixed MCP tool calls in resumed sessions and HTML exports rendering fully expanded until their server connected, or for good if it never did ([#10285](https://github.com/earendil-works/pi/issues/10285))
- **1.0.1/19** (line 323; [source](latest.md#101)): Fixed fullscreen Kitty images collapsing to a one-row strip after scrolling in WezTerm ([#10319](https://github.com/earendil-works/pi/issues/10319))
- **1.0.4/05** (line 246; [source](latest.md#104)): Fixed syntax highlighting losing colors after the first line of multiline strings and comments in fenced code blocks ([#10143](https://github.com/earendil-works/pi/issues/10143))

</details>

### W7 — Configuration schemas, sampling, and loader improvements

**Upstream:** Official configuration schemas/reference include descriptions; themes validate at startup with a new schema URL; sampling can vary by thinking level; worktree AGENTS and tilde resource settings load correctly; quoted empty prompt arguments survive; pi-ai/models imports load.

**Local evidence:** `packages/ext/config.ts`, `pi-bites.schema.json`, and `scripts/generate-config-schema.ts` own a separate extension schema, not Pi settings/models/theme schemas. No shipped Pi themes or old theme schema URLs, sampling override implementation, or pi-ai/models import was found. `inline-references/index.ts` loads prompt content; `prompt-normalization/index.ts` only strips trailing horizontal whitespace, not positional argument parsing.

**Next action:** Keep the pi-bites schema URL; do not replace it with Pi’s settings schema. Link users to the generated Models Configuration reference when configuring overrides. Migrate theme metadata/vars only if themes are later shipped; retain host template parsing and resource loading.

<details>
<summary>Classified source entries</summary>

- **1.4.0/02** (line 20; [source](latest.md#140)): **Models Configuration reference**: every provider, model, model override, and compatibility field of `models.json`, generated from its schema. See [Models Configuration](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/models-configuration.md).
- **1.4.0/06** (line 27; [source](latest.md#140)): Added a Models Configuration reference generated from the `models.json` schema, listing all provider, model, model override, and compatibility fields ([#10790](https://github.com/earendil-works/pi/issues/10790))
- **1.4.0/19** (line 46; [source](latest.md#140)): Fixed `models.schema.json` missing descriptions for provider and model fields, so editors showed no hints for them ([#10790](https://github.com/earendil-works/pi/issues/10790))
- **1.4.0/26** (line 53; [source](latest.md#140)): Fixed extensions failing to load when importing `@earendil-works/pi-ai/models` (e.g. for `clampThinkingLevel`) by exposing the subpath through the extension loader aliases and virtual modules ([#11156](https://github.com/earendil-works/pi/issues/11156))
- **1.2.0/02** (line 122; [source](latest.md#120)): **Published configuration schemas**: add `$schema` to `settings.json`, `models.json`, keybindings, and themes for editor validation and completion. See [Settings](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/docs/settings.md), [Models](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/docs/models.md), [Keybindings](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/docs/keybindings.md), and [Themes](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/docs/themes.md).
- **1.2.0/06** (line 129; [source](latest.md#120)): Published generated configuration schemas for models, settings, keybindings, and themes at `https://pi.dev/schemas/*.schema.json`. The theme schema moved to `https://pi.dev/schemas/theme.schema.json`; themes loaded during startup now receive the same schema validation as later reloads. Update theme `$schema` references, define reusable colors under `vars`, and remove unsupported metadata ([#9880](https://github.com/earendil-works/pi/pull/9880), [#10751](https://github.com/earendil-works/pi/pull/10751) by [@christianklotz](https://github.com/christianklotz))
- **1.2.0/21** (line 153; [source](latest.md#120)): Fixed a symlinked `AGENTS.md` in a git worktree nested inside its main repo causing no project context file to load ([#10681](https://github.com/earendil-works/pi/issues/10681))
- **1.2.0/27** (line 159; [source](latest.md#120)): Fixed `~` not being expanded in `!pattern`, `+path`, and `-path` entries of the `extensions`, `skills`, `prompts`, and `themes` settings, so entries like `!~/skills/pdf` matched nothing ([#10765](https://github.com/earendil-works/pi/issues/10765))
- **1.0.2/01** (line 286; [source](latest.md#102)): **Sampling by thinking level** — `samplingParamsByThinkingLevel` in `models.json` sets sampling parameters such as `temperature` and `top_p` for each thinking level on OpenAI-compatible APIs. See [Configure sampling by thinking level](https://github.com/earendil-works/pi/blob/v1.0.2/packages/coding-agent/docs/models.md#configure-sampling-by-thinking-level).
- **1.0.2/02** (line 290; [source](latest.md#102)): Added `samplingParamsByThinkingLevel` to `models.json` for per-thinking-level sampling parameter overrides on OpenAI-compatible APIs. See [Configure sampling by thinking level](https://github.com/earendil-works/pi/blob/v1.0.2/packages/coding-agent/docs/models.md#configure-sampling-by-thinking-level) ([#9776](https://github.com/earendil-works/pi/pull/9776) by [@mrexodia](https://github.com/mrexodia))
- **1.3.0/18** (line 101; [source](latest.md#130)): Fixed prompt templates dropping empty quoted arguments (`""` or `''`), which shifted later positional arguments and prevented positional defaults from applying ([#10867](https://github.com/earendil-works/pi/issues/10867))

</details>

### W8 — Installation, shell environment, and package hardening

**Upstream:** Nix install/build/PATH behavior, managed update retention/BOM parsing, exact internal package pins, removal of npm shrinkwrap, brace-expansion security pins, standalone dotenv loading, Windows auth locks, and Windows shell detection change.

**Local evidence:** `package.json` pins both Pi development packages to 1.2.0 and has wildcard Pi peers; `scripts/update-pi.sh` copies installed pi -v into those two pins and runs bun install. `bun.lock` owns this repo’s development graph; no local Nix flake or managed-install implementation exists. Local exec native helpers have separate environment/shell rules.

**Next action:** For an accepted 1.4 upgrade, verify the selected executable is 1.4.0 before running update-pi.sh, review bun.lock, then rerun validation and CLI/route smokes. Current green tests only cover 1.2.0. Verify node/npm selection and Windows execution separately if supported; host fixes do not rewrite local exec behavior. Do not widen or raise supported-host minimum silently.

<details>
<summary>Classified source entries</summary>

- **1.0.1/01** (line 296; [source](latest.md#101)): **Nix flake** — `nix run github:earendil-works/pi/stable` runs the latest release, and `nix profile add github:earendil-works/pi/stable` installs it. See [Install pi](https://github.com/earendil-works/pi/blob/v1.0.1/packages/coding-agent/docs/quickstart.md#1-install-pi).
- **1.0.1/11** (line 309; [source](latest.md#101)): Added a Nix flake for macOS and Linux: `nix run github:earendil-works/pi/stable` runs the latest release, and `nix profile add github:earendil-works/pi/stable` installs it. See [Install pi](https://github.com/earendil-works/pi/blob/v1.0.1/packages/coding-agent/docs/quickstart.md#1-install-pi) ([#9137](https://github.com/earendil-works/pi/pull/9137))
- **1.0.1/12** (line 313; [source](latest.md#101)): `pi update` on global npm installations now recommends migrating to the managed installation from the pi.dev installer, which pins all dependencies.
- **1.0.1/14** (line 318; [source](latest.md#101)): Fixed installations resolving vulnerable `brace-expansion` 5.0.9 by pinning `brace-expansion` 5.0.12 as a direct dependency (GHSA-q2hr-2g5m-vwhr, GHSA-qhr7-859c-m2p7, GHSA-6j4f-fj2g-mc7p) ([#10288](https://github.com/earendil-works/pi/issues/10288))
- **1.0.1/27** (line 334; [source](latest.md#101)): Removed `npm-shrinkwrap.json` from the published package. npm installations no longer pin transitive dependencies, and library consumers can now override them. Use the pi.dev installer for pinned installations ([#5653](https://github.com/earendil-works/pi/issues/5653))
- **1.1.0/18** (line 210; [source](latest.md#110)): Fixed managed installs keeping every old release; `pi update` now keeps only the new release and the one it updated from ([#10392](https://github.com/earendil-works/pi/issues/10392), [#10511](https://github.com/earendil-works/pi/pull/10511) by [@davidbrai](https://github.com/davidbrai))
- **1.1.0/19** (line 211; [source](latest.md#110)): Fixed standalone binaries loading `.env`, `.env.local`, and `.env.development` from the launch directory into Pi's environment ([#10473](https://github.com/earendil-works/pi/issues/10473))
- **1.3.0/10** (line 93; [source](latest.md#130)): Pinned internal Pi dependencies to exact release versions to prevent fresh installs from mixing incompatible packages ([#10865](https://github.com/earendil-works/pi/issues/10865))
- **1.3.0/16** (line 99; [source](latest.md#130)): Fixed the Nix flake build failing when a provider switched APIs: the model catalog pin is now refreshed from the newest published catalog when its model API groups differ, and releases pin the newest catalog and build with it before tagging ([#10985](https://github.com/earendil-works/pi/issues/10985))
- **1.3.0/17** (line 100; [source](latest.md#130)): Fixed the Nix package putting its Node.js first on `PATH`, which made bash tool shells use Pi's Node instead of the user's `node`/`npm`. Pi's Node is now only a fallback ([#10519](https://github.com/earendil-works/pi/issues/10519))
- **1.3.0/19** (line 102; [source](latest.md#130)): Fixed the Nix package build failing in its install check because it still expected chord and esbuild, which Pi no longer depends on
- **1.4.0/20** (line 47; [source](latest.md#140)): Fixed `pi update` failing with "Managed install marker is missing or invalid" when `managed-install.json` starts with a UTF-8 BOM, which Windows PowerShell 5.1 adds when it rewrites the file.
- **1.4.0/32** (line 59; [source](latest.md#140)): Fixed Windows shell detection rejecting runnable Microsoft Store shell aliases ([#9504](https://github.com/earendil-works/pi/pull/9504) by [@petrroll](https://github.com/petrroll))
- **1.4.0/33** (line 60; [source](latest.md#140)): Fixed Windows shell detection missing PowerShell outside `PATH` and the legacy WSL `bash.exe` launcher when Windows is not installed in `C:\Windows`. pi now checks `%ProgramFiles%\PowerShell\7`, `%SystemRoot%\System32\WindowsPowerShell\v1.0`, and `%SystemRoot%` ([#9501](https://github.com/earendil-works/pi/pull/9501) by [@petrroll](https://github.com/petrroll))
- **1.2.0/30** (line 162; [source](latest.md#120)): Fixed reading or writing `auth.json` on Windows failing with `EPERM` when the previous lock folder was still being deleted; Pi now retries briefly before reporting the error ([#10801](https://github.com/earendil-works/pi/issues/10801))

</details>

### W9 — Login robustness does not replace local account logic

**Upstream:** OAuth refresh survives cancellation, occupied callback ports fail clearly or find a fallback, and sign-in URLs gain a copy key.

**Local evidence:** `packages/ext/token-count/index.ts` queries subscription usage with specific account provenance; `codex-adapter/web-run/tool.ts` resolves provider auth before spawning a search helper. Neither implements Pi’s interactive browser login.

**Next action:** Inherit host login improvements. Keep account-source separation, own request cancellation/timeouts, and stale-session protections; use /login to recover credentials rather than adding callback listeners here.

<details>
<summary>Classified source entries</summary>

- **1.0.3/08** (line 278; [source](latest.md#103)): Fixed subscription logins such as Sign in with ChatGPT failing with `refresh_token_invalidated` after a request was cancelled during an OAuth token refresh
- **1.0.1/06** (line 304; [source](latest.md#101)): Added a copy key (`app.message.copy`, default `ctrl+x`) to OAuth sign-in screens in `/login`, `/mcp`, and `/mcp login`, which copies the sign-in URL when the browser cannot be opened or the wrapped link cannot be selected.
- **1.0.1/22** (line 326; [source](latest.md#101)): Fixed Sign in with ChatGPT continuing when its callback port is taken by another login, which made the browser show "OAuth state mismatch"; it now fails with a port-in-use error ([#10265](https://github.com/earendil-works/pi/issues/10265))
- **1.1.0/36** (line 228; [source](latest.md#110)): Fixed Anthropic browser login failing with "localhost refused to connect" when port 53692 is reserved or in use, for example by Hyper-V/WSL port exclusions on Windows: login now falls back to a free loopback port ([#10571](https://github.com/earendil-works/pi/issues/10571))

</details>

### W10 — Native MCP changes matter only when the full host loads it

**Upstream:** Project overrides and CIMD arrive; OAuth registration/cancellation/issuer checking/shutdown improve; list output reports resources:true instead of counts; resource enumeration no longer blocks tools; BOM config parsing works.

**Local evidence:** `package.json` development command and `subagents/agent-runner.ts` do not explicitly load native MCP. Adapter activation preserves unrelated tools and native codemode can reach host-provided MCP tools. No local mcp.json parser, MCP OAuth client, resource-count consumer, or pi mcp list --json invocation was found.

**Next action:** No MCP implementation migration here. On a full-host interoperability smoke, check startup/refresh cancellation, nested discovery, and intentional exposure. Do not auto-load user MCP servers into SDK children; if later consuming list JSON, accept resources:true rather than counts.

<details>
<summary>Classified source entries</summary>

- **1.0.1/02** (line 297; [source](latest.md#101)): **Project overrides for MCP servers** — `.pi/mcp.json` and `/mcp` can enable, disable, or change the exposure of a user-level server for one project. See [Configure servers](https://github.com/earendil-works/pi/blob/v1.0.1/packages/coding-agent/docs/mcp.md#configure-servers).
- **1.0.1/03** (line 298; [source](latest.md#101)): **MCP Client ID Metadata Documents** — `oauth.clientRegistration: "cimd"` lets authorization servers allow pi by its document URL instead of dynamic registration. See [Authenticate with OAuth](https://github.com/earendil-works/pi/blob/v1.0.1/packages/coding-agent/docs/mcp.md#authenticate-with-oauth).
- **1.0.1/07** (line 305; [source](latest.md#101)): Added `oauth.clientRegistration: "cimd"` for MCP servers, which identifies pi with its Client ID Metadata Document on pi.dev instead of dynamic client registration, so authorization servers can allow pi by URL ([#10302](https://github.com/earendil-works/pi/issues/10302))
- **1.0.1/08** (line 306; [source](latest.md#101)): Added project overrides for user-level MCP servers: a `.pi/mcp.json` entry without `command` or `url` sets only `enabled`, `exposure`, and `toolExposure` of the user-level server, and `/mcp` can enable or disable a server for the current project ([#10277](https://github.com/earendil-works/pi/issues/10277))
- **1.0.4/07** (line 248; [source](latest.md#104)): Fixed MCP OAuth sign-in failing with `invalid_redirect_uri` on servers with OpenID Connect client registration, such as `mcp.modem.dev`: pi now registers as a native client ([#10493](https://github.com/earendil-works/pi/issues/10493))
- **1.0.4/09** (line 250; [source](latest.md#104)): Fixed MCP session shutdown returning while a server was still connecting, leaving its transport open until the server answered or timed out ([#10249](https://github.com/earendil-works/pi/issues/10249))
- **1.1.0/16** (line 205; [source](latest.md#110)): Changed `pi mcp login --timeout` to limit the whole sign-in, including requests to the authorization server, instead of only the wait for the browser ([#10565](https://github.com/earendil-works/pi/issues/10565))
- **1.1.0/23** (line 215; [source](latest.md#110)): Fixed `/mcp` waiting for all servers to connect before opening; the manager now updates live and remains usable while enabling, reconnecting, or disabling servers ([#10562](https://github.com/earendil-works/pi/issues/10562))
- **1.1.0/27** (line 219; [source](latest.md#110)): Fixed MCP OAuth sign-ins that could not be cancelled while waiting on the authorization server and kept running after the session ended. The sign-in screen now cancels with Esc at every step, session shutdown aborts a running sign-in, and each request to the authorization server times out after 15 seconds ([#10565](https://github.com/earendil-works/pi/issues/10565))
- **1.1.0/28** (line 220; [source](latest.md#110)): Fixed shutdown waiting up to 15 seconds to refresh an MCP OAuth token that was about to expire, only to close the server's session ([#10565](https://github.com/earendil-works/pi/issues/10565))
- **1.2.0/09** (line 132; [source](latest.md#120)): Changed `pi mcp list --json` to report `resources: true` for servers that offer resources instead of `resources` and `resourceTemplates` counts; Pi no longer lists resources when connecting ([#10526](https://github.com/earendil-works/pi/issues/10526))
- **1.2.0/26** (line 158; [source](latest.md#120)): Fixed `pi mcp login --help` and the CLI docs describing `--timeout` as only the wait for the browser; it limits the whole sign-in ([#10636](https://github.com/earendil-works/pi/issues/10636))
- **1.2.0/28** (line 160; [source](latest.md#120)): Fixed MCP servers with resources registering no tools until every resource was listed; Pi no longer lists resources when connecting, so `/mcp` and `pi mcp list` show that a server offers resources instead of counting them ([#10526](https://github.com/earendil-works/pi/issues/10526))
- **1.2.0/39** (line 171; [source](latest.md#120)): Fixed MCP tool calls that were cancelled or timed out while waiting for an OAuth refresh still being sent to the server once the refresh finished ([#10598](https://github.com/earendil-works/pi/issues/10598))
- **1.2.0/40** (line 172; [source](latest.md#120)): Fixed MCP OAuth sign-in accepting an authorization response with an `iss` parameter that could not be checked because no authorization server metadata was discovered; sign-in now fails with an issuer mismatch. Reported by [@AizenvoltPrime](https://github.com/AizenvoltPrime)
- **1.4.0/27** (line 54; [source](latest.md#140)): Fixed `mcp.json` files that start with a UTF-8 BOM failing to parse, which skipped all their MCP servers and made `pi mcp add`/`pi mcp remove` fail ([#11191](https://github.com/earendil-works/pi/issues/11191))

</details>

### W11 — Sharing destination is user-controlled upstream

**Upstream:** sessionShareDestination selects auto, gist, or radius for /share.

**Local evidence:** `packages/ext/inline-references/index.ts` only lists share as a built-in command name; no upload implementation or destination setting is shipped.

**Next action:** Keep the built-in name exclusion. Set the upstream setting only for an explicit user sharing/privacy requirement; do not add a duplicate pi-bites upload option.

<details>
<summary>Classified source entries</summary>

- **1.3.0/01** (line 75; [source](latest.md#130)): **Choose where `/share` uploads**: `sessionShareDestination` selects `auto`, `gist`, or `radius`. See [Sessions and context](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/docs/settings.md#sessions-and-context) and [Export or share a session](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/docs/sessions.md#export-or-share-a-session).
- **1.3.0/07** (line 84; [source](latest.md#130)): Added the `sessionShareDestination` setting to choose automatic, GitHub gist, or Radius uploads for `/share` ([#10870](https://github.com/earendil-works/pi/issues/10870) by [@vegarsti](https://github.com/vegarsti))

</details>

### W12 — Truncated print output now exits nonzero

**Upstream:** Print mode warns and exits 1 when the final answer hits the model output limit, while preserving partial text.

**Local evidence:** `packages/ext/index.ts` detects print mode; `scripts/native-codemode-cli-smoke.ts`, `subagents-route-smoke.ts`, and `subagents/test/helpers/print-mode-runner.ts` spawn/inspect CLI results. Production embedded children use AgentSession, not print exit codes.

**Next action:** Treat nonzero truncation as an incomplete run, not necessarily a harness launch failure. Preserve stdout/stderr when diagnosing smoke failures; do not change expected successful probe exit status.

<details>
<summary>Classified source entries</summary>

- **1.2.0/25** (line 157; [source](latest.md#120)): Fixed print mode (`-p`) exiting 0 without a warning when the final response was cut off at the model's output token limit; it now prints the partial text, writes a warning to stderr, and exits 1 ([#10799](https://github.com/earendil-works/pi/issues/10799))

</details>

### W13 — Independent renderer registration is available when needed

**Upstream:** registerToolRenderer draws calls for tools not yet registered, including restored/disconnected MCP tools.

**Local evidence:** `packages/ext/tools.ts` and adapter owned tools register rendering with their definitions. `native-rendering.ts` retains known owned renderers and provides metadata-only presentation for unrelated nested calls; it does not resolve arbitrary MCP renderer definitions. No registerToolRenderer call exists.

**Next action:** Use the independent API only when adding a specific renderer for a tool owned elsewhere or restored before registration. Keep unrelated nested tools metadata-only unless a concrete richer display is requested; no replacement renderer registry is needed now.

<details>
<summary>Classified source entries</summary>

- **1.0.1/04** (line 299; [source](latest.md#101)): **Tool renderers for any tool** — `pi.registerToolRenderer()` draws calls to tools that are not registered yet, such as MCP tools in resumed sessions. See [Tool rendering](https://github.com/earendil-works/pi/blob/v1.0.1/packages/coding-agent/docs/extensions.md#tool-rendering).
- **1.0.1/10** (line 308; [source](latest.md#101)): Added `pi.registerToolRenderer()`, which chooses how calls to a tool are drawn, including tools that are not registered ([#10285](https://github.com/earendil-works/pi/issues/10285))

</details>

## Ignore

### I1 — Removed unpublished APIs and unused custom-editor integration

**Upstream:** Custom-editor compaction indicator colors are fixed; the unpublished experimental server/client/plugin stack and chord dependency are removed.

**Local evidence:** No setEditorComponent/custom editor, imports of the removed experimental/client packages, or chord dependency exists in production packages, scripts, or package.json. TUI viewers/autocomplete wrappers are not custom editor components.

**Next action:** None. Revisit only if adding a custom editor or importing formerly unpublished APIs.

<details>
<summary>Classified source entries</summary>

- **1.2.0/38** (line 170; [source](latest.md#120)): Fixed the compaction status indicator embedded in a custom editor using the default muted colors instead of the editor border or thinking-level color, as the working indicator does ([#10809](https://github.com/earendil-works/pi/issues/10809), [#10810](https://github.com/earendil-works/pi/pull/10810) by [@Jay-Madden](https://github.com/Jay-Madden))
- **1.2.0/42** (line 177; [source](latest.md#120)): Removed the unreleased experimental server, client, and plugin stack (`src/experimental`, `src/cli/experimental`) and its source-only `./client` and `./experimental/plugin` exports; none of it was part of the published package. The `@earendil-works/pi-client`, `@earendil-works/pi-protocol`, and `@earendil-works/pi-server` packages it used are removed and no longer released
- **1.2.0/43** (line 178; [source](latest.md#120)): Removed the dependency on `@earendil-works/chord`

</details>
