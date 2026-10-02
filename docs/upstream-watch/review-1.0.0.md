# Pi upstream review — 0.84.0 → 1.0.0

Reviewed: 2026-10-02. Source: [`latest.md`](latest.md), fetched from the published `@earendil-works/pi-coding-agent` npm tarball by the bundled helper.

Checkpoint remains **0.84.0** (`state.json`, last checked 2026-08-07). Latest published host is **1.0.0**; local Pi development dependencies are **0.99.1**. Fourteen releases contain **438 changelog bullets**, including duplicated feature summaries: 6 adapt, 52 leverage, 326 watch, 54 irrelevant. Every bullet is classified below; `version/item` numbers are in source order within each release. Each grouped entry inherits its group's local evidence and next action. Source line numbers disambiguate repeated entries.

This is a review, not an accepted upgrade: no extension implementation or dependency version has been changed. API details were checked against the published Pi 1.0 distribution and installed docs, not just inferred from headlines.

## Adapt

**Validation baseline:** before claiming 1.0 compatibility, align all three Pi development dependencies through `scripts/update-pi.sh` (after confirming the selected host is 1.0.0), refresh `bun.lock`, and run `bun check` plus interactive/live smokes. Current validation still uses 0.99.1. Do not raise the supported minimum or widen `peerDependencies` semantics silently; `RELEASES.md` treats a minimum-host increase as breaking.

### A1 — Preserve built-in read metadata

**Upstream:** 0.99.2 fixes renderer examples dropping built-in summaries/guidelines.
**Local evidence:** `packages/ext/tools.ts` spreads `createReadTool(cwd)` into its registration, but uses `createReadToolDefinition(cwd)` only for the result renderer. Pi 1.0's `dist/core/tools/tool-definition-wrapper.js` retains `constrainedSampling` but strips `promptSnippet`, `promptGuidelines`, and renderers. The edit override supplies its own prompt metadata; bash already spreads its full definition.
**Next action:** register read from the existing `originalReadDef` instead of the AgentTool wrapper, retaining the intentional result override. Check that read's call renderer and prompt contributions survive. Do not blindly change the custom edit schema or replace its guidance. This is a confirmed local omission, not merely an upstream example fix.

<details>
<summary>1 classified upstream entries</summary>

- **0.99.2/19** (source line 92): Fixed the `built-in-tool-renderer.ts` and `minimal-mode.ts` extension examples removing the built-in tools' summaries and guidelines from the system prompt.

</details>

### A2 — Validate the new fullscreen default

**Upstream:** 1.0.0 makes fullscreen the default; `tuiMode: "regular"` or `--tui-mode regular` restores scrollback.
**Local evidence:** `packages/ext/footer/index.ts` installs a custom footer; `packages/ext/statusline.ts`, `packages/ext/token-count/index.ts`, `packages/ext/view/index.ts`, and `packages/ext/subagents/ui/` render custom content. `file-search/index.ts` and `inline-references/index.ts` wrap autocomplete. There is no custom editor to opt into embedded spinners.
**Next action:** smoke-test approval dialogs, custom viewers, footer resizing, selection/expansion, and autocomplete in default fullscreen and regular mode. Document the regular-mode escape hatch in `README.md`. No confirmed fullscreen crash was found; this is a required behavior-compatibility check, not an instruction to rewrite the TUI.

<details>
<summary>2 classified upstream entries</summary>

- **1.0.0/01** (source line 19): **Fullscreen by default** — The TUI now runs fullscreen. Set `tuiMode` to `"regular"` to keep the terminal's normal scrollback. See Terminal and display.
- **1.0.0/12** (source line 36): Changed the default TUI mode to fullscreen. Set `tuiMode` to `"regular"` or pass `--tui-mode regular` to keep the terminal's normal scrollback.

</details>

### A3 — Keep optional PowerShell outside ungated execution

**Upstream:** 0.84.3 adds an optional native `powershell` tool.
**Local evidence:** `packages/ext/bash-gate/index.ts:commandPolicyRequest()` recognizes only `bash.command` and `exec_command.cmd`; its authorization types have the same two names. `packages/ext/codex-adapter/activation.ts` displaces only read/bash/edit/write and preserves unrelated tools. Thus enabling PowerShell does not cause the existing bash gate to approve it.
**Next action:** fail closed for PowerShell when bash-gate protection is expected, or explicitly exclude it from permitted tools. Only add support when a PowerShell-aware policy exists; Bash parsing is not safe policy enforcement for another shell. The tool is optional, so this is conditional on enabling it, not a default Linux regression.

<details>
<summary>2 classified upstream entries</summary>

- **0.84.3/01** (source line 488): **PowerShell tool** — Use optional native PowerShell command execution on Windows. See PowerShell Tool.
- **0.84.3/05** (source line 498): Added an optional `powershell` tool for Windows, configurable through `defaultTools` and the SDK. See PowerShell Tool.

</details>

### A5 — Make the development built-in policy explicit

**Upstream:** 0.99.0 makes `--no-extensions` disable built-in extensions too; individual built-ins can be restored with `-e builtin:<name>`.
**Local evidence:** `package.json:scripts.dev` runs `pi -ne -e ./packages/ext/index.ts`. This now excludes native MCP, codemode, tool-search, and llama.cpp. SDK child sessions in `packages/ext/subagents/agent-runner.ts` construct their own loader/tool allowlist and do not automatically inherit CLI built-ins.
**Next action:** document that the development command deliberately tests isolated pi-bites. If full CLI interoperability is needed, use a separate smoke invocation with explicit built-ins; do not remove isolation or silently expand child permissions.

<details>
<summary>1 classified upstream entries</summary>

- **0.99.0/34** (source line 162): `--no-extensions` also disables the built-in extensions, including the llama.cpp provider. Load one explicitly with `-e builtin:<name>`, for example `pi -ne -e builtin:mcp`.

</details>

## Leverage

### L1 — Native nested-tool orchestration is a possible shared seam

**Upstream:** 0.99.0 adds `exposure`, namespaces, structured results, `prepareLoadout()`, and `ctx.executeTool()` with parent IDs and nested usage aggregation.
**Local evidence:** `packages/ext/codex-adapter/code-mode/nested-adapters.ts` invokes owned tools directly; `nested-tools.ts`, `nested-traces.ts`, and `rendering.ts` implement authorization, tracing, and presentation around a persistent V8 exec/wait runtime. `subagents/operations.ts` also captures execution dependencies itself.
**Next action:** consider `ctx.executeTool()` only for synchronous session-owned nested calls where it preserves validation, policy, error details, and usage. Do not move yielded-cell continuations onto captured ctx. Native orchestration is not a drop-in replacement for the adapter's persistence/yield contract; keep the bridge until equivalence is demonstrated.

<details>
<summary>2 classified upstream entries</summary>

- **0.99.0/07** (source line 132): Added extension tool APIs for orchestrating tools: `exposure` (`direct`, `model-only`, `codemode`, `deferred`, or `hidden`), `namespace`, `annotations`, `outputSchema` with `structuredContent`, `isError` results, `prepareLoadout()`, and `ctx.executeTool()` for nested tool calls, which emit events with `parentToolCallId` and are recorded as bounded `nestedCalls` on the calling tool's result. See Tool exposure.
- **0.99.0/51** (source line 182): Fixed the usage of tools called through `ctx.executeTool()`, for example from codemode scripts, being dropped from the session cost; it is now added to the calling tool's result usage.

</details>

### L2 — Actionable lifecycle and full-context hooks are already partly adopted

**Upstream:** 0.87.0 adds actionable `turn_end`/`agent_before_settle`, and separates `context` from `context_with_system`.
**Local evidence:** `packages/ext/subagents/subagent-messages.ts` observes only custom messages in `context` and returns `{ continue: true }` from `agent_before_settle`; it does not require system messages. `packages/ext/auto-compaction.ts` uses `turn_end`. Tests under `subagents/test/` cover unread-message delivery and settle behavior. No `shouldStopAfterTurn` or manual `ExtensionRunner.emit("turn_end")` use was found.
**Next action:** retain current boundary hooks and their delivery tests. Use `context_with_system` only if a future transformation really owns the complete system/tool transcript; do not migrate the existing observer unnecessarily. Use public continuation boundaries before adding new custom restart machinery.

<details>
<summary>5 classified upstream entries</summary>

- **0.87.0/02** (source line 227): **Full-transcript context extensions** — Use `context_with_system` for per-request system-message transformations. See `context_with_system`.
- **0.87.0/07** (source line 235): Expanded `TurnEndEvent` with required boundary fields and added `AgentBeforeSettleEvent` to the exported `ExtensionEvent` union. Consumers constructing events or exhaustively switching on `ExtensionEvent` must handle the new shapes. `ExtensionRunner.emit()` no longer accepts `turn_end`; host integrations dispatch actionable boundaries with `emitBoundary(baseEvent, buildContext)`.
- **0.87.0/10** (source line 241): Added actionable `turn_end` and `agent_before_settle` extension boundaries. Return `{ entries: [...event.entries, draft], continue: true }` to persist structural entries in order and ensure one next provider request without changing steering or follow-up scheduling.
- **0.87.0/12** (source line 243): Added the `context_with_system` extension event, which runs after `context` handlers on the full transcript including system messages and sends its result verbatim. See `context_with_system`.
- **0.87.0/18** (source line 252): Fixed `context` handlers that filter or slice messages dropping the prompt and tool declarations, which after extension-driven compaction left requests without built-in tools or made Codex emit raw tool-call text. Handlers no longer see system messages; Pi restores the prompt and tool state after they run. See `context`.

</details>

### L3 — Inherit tool and rendering fixes rather than duplicate them

**Upstream:** 0.84.1–0.99.0 improve built-in guidance, fallback expansion, edit normalization, cwd handling, read ranges, shell status/durations, and write output.
**Local evidence:** `packages/ext/tools.ts` delegates bash and edit renderers and built-in execution, while deliberately implementing a different old_string/new_string edit contract and always-collapsed read result. `packages/ext/tool-fallback.test.ts` and `tools.test.ts` cover renderer/execution behavior. `code-mode/rendering.ts` delegates owned nested renderers.
**Next action:** keep inherited fixes; preserve the custom edit interface and intentional read-collapse exception. When upgrading, run focused rendering tests for narrow widths, partial/final/restored results, null read ranges, and durations. Do not add single-object edit-array compatibility to a tool whose public schema is not the built-in schema.

<details>
<summary>10 classified upstream entries</summary>

- **0.99.0/35** (source line 163): Tool calls without a custom call renderer, including direct MCP tool calls, now show their arguments: as `key=value` pairs on the title line when collapsed and one `key: value` line per argument when expanded. MCP calls are titled `server/tool` and their results collapse to 5 lines.
- **0.99.0/41** (source line 172): Fixed full-file `read` calls rendering as `:1` when models send `null` for omitted `offset` and `limit`.
- **0.86.0/27** (source line 321): Formatted Bash and PowerShell tool durations of at least one minute as minutes and seconds, with hours when needed.
- **0.86.0/52** (source line 349): Fixed signal-terminated local shell commands being reported as successful with partial output.
- **0.85.0/27** (source line 426): Fixed `bash`, `edit`, `find`, `grep`, `ls`, `read`, and `write` tools ignoring `ctx.cwd`.
- **0.85.0/33** (source line 432): Fixed the write tool reporting UTF-16 code-unit counts as byte counts by removing the misleading count.
- **0.84.3/32** (source line 531): Fixed single-object `edit` tool inputs failing validation by accepting them as one-edit arrays in both coding-agent and harness edit tools.
- **0.84.2/20** (source line 597): Fixed single-object `edit` tool inputs failing validation by accepting them as one-edit arrays in both coding-agent and harness edit tools.
- **0.84.2/27** (source line 604): Fixed fallback rendering for extension tool results to collapse long output and honor tool expansion.
- **0.84.1/10** (source line 643): Softened the bash tool's `PI_*` environment guideline in an attempt to reduce unnecessary inspection commands.

</details>

### L4 — Reuse resource/completion fixes without replacing custom references

**Upstream:** 0.84.2–1.0 fix skill discovery, frontmatter warnings, slash/path completion and fuzzy search; 0.84.2 adds `expandPromptTemplates`.
**Local evidence:** `packages/ext/file-search/index.ts` delegates path browsing and unavailable results to Pi but owns FFF ranking, wrapper prefixes and CJK quoting. `packages/ext/inline-references/index.ts` owns `$skill:`/`$prompt:` discovery, hidden attachment and autocomplete; `at-mention-context/index.ts` also handles input. These are not the same behavior as visible slash expansion.
**Next action:** keep the custom semantics and delegate host fallback paths. Retain CJK/wrapper tests; smoke-test whitespace slash completion and malformed templates after upgrading. Use `expandPromptTemplates: true` only when a future `sendUserMessage` intentionally dispatches slash commands; no blanket expansion change is needed.

<details>
<summary>14 classified upstream entries</summary>

- **0.99.0/52** (source line 183): Fixed inherited `/skill` autocomplete appearing empty when loaded skill names did not contain the letters in `skill`.
- **0.99.0/53** (source line 184): Fixed inherited path and `@` autocomplete not working after opening wrappers such as `(`, `[`, `{`, `<`, or a backtick.
- **0.87.0/23** (source line 257): Fixed malformed prompt template frontmatter being silently ignored instead of reported as a resource warning.
- **0.86.0/24** (source line 318): Reduced inherited fuzzy search latency for long texts by using native substring search instead of scanning each character in JavaScript.
- **0.86.0/55** (source line 352): Fixed direct RPC `steer` and `follow_up` commands bypassing extension `input` handlers.
- **0.86.0/63** (source line 360): Fixed inherited skill slash-command autocomplete ranking the `skill:` prefix instead of the bare skill name.
- **0.86.0/64** (source line 361): Fixed inherited file autocomplete boundaries and path quoting around CJK punctuation.
- **0.85.0/19** (source line 418): Fixed skills being unavailable when Bash is the only enabled tool.
- **0.84.4/26** (source line 474): Fixed inherited `@` file autocomplete ranking to prefer direct and shallower matches over similarly ranked nested paths.
- **0.84.3/30** (source line 529): Fixed nested Markdown skills inside `.agents/skills/` grouping directories not being discovered.
- **0.84.3/33** (source line 532): Fixed root Markdown files such as `README.md` and `AGENTS.md` in skill directories being reported as broken skills unless they declare valid skill frontmatter.
- **0.84.3/46** (source line 545): Fixed UTF-8 BOM markers preventing frontmatter and user configuration files from loading.
- **0.84.2/10** (source line 581): Added `expandPromptTemplates` to extension `pi.sendUserMessage()` options for explicitly dispatching commands and expanding skills and prompt templates. See `pi.sendUserMessage()`.
- **0.84.2/19** (source line 596): Fixed root Markdown files such as `README.md` and `AGENTS.md` in skill directories being reported as broken skills unless they declare valid skill frontmatter.

</details>

### L5 — Message and input scheduling fixes support the existing messenger

**Upstream:** 0.84.2–0.99.0 fix custom-message ordering/non-steering behavior and RPC input hooks, and expose input disposition.
**Local evidence:** `packages/ext/subagents/subagent-messages.ts` sends custom mailbox messages and consumes activity at provider-context boundaries; `subagents/agent-session-shutdown.ts` and `agent-runner.ts` manage child steering/follow-ups. `at-mention-context/index.ts` and prompt-normalization hooks transform input. Existing messenger/print-mode end-to-end tests cover scheduling.
**Next action:** keep the explicit deliverAs/triggerTurn choices and rerun messenger tests against 1.0. Use new disposition values where callers need acceptance-vs-queued feedback; do not assume a successful RPC response means the message has already reached inference.

<details>
<summary>5 classified upstream entries</summary>

- **0.99.0/16** (source line 141): Added per-input disposition to successful RPC `prompt`, `steer`, and `follow_up` responses, `AgentSession.steer()`/`followUp()`, and `RpcClient.prompt()`/`steer()`/`followUp()`; `RpcClient.prompt()` also accepts `streamingBehavior`.
- **0.84.4/21** (source line 469): Fixed extension messages sent with `triggerTurn: false` while the agent is running being inserted between a tool call and its result, which made providers that validate message order reject the replayed history. They are now appended once the turn's tool results are in.
- **0.84.3/28** (source line 527): Fixed JSON and RPC `toolcall_start` events omitting the tool call id and name.
- **0.84.2/28** (source line 605): Fixed JSON and RPC `message_update` events dropping cumulative usage during streaming. See JSON Event Mode and RPC `message_update`.
- **0.84.2/29** (source line 606): Fixed `pi.sendMessage(..., { triggerTurn: false })` steering an active run instead of only recording the custom message.

</details>

### L6 — Packaging changes fit the current host-dependency strategy

**Upstream:** 0.84.3 improves managed updates; 0.99.0 stops installing Pi peer dependencies for managed git packages and fixes pinned refs.
**Local evidence:** `package.json` has host Pi packages in peers/devDependencies, not runtime dependencies; `RELEASES.md` documents immutable exact git tags and separate host/package updates. `scripts/update-pi.sh` updates all three development Pi packages together.
**Next action:** retain peer dependencies and exact release pins. Verify a clean managed-git install against the 1.0 host, especially host-provided `typebox`/Pi module identity. No new bundling or installer machinery is warranted.

<details>
<summary>5 classified upstream entries</summary>

- **0.99.0/38** (source line 169): Prevented managed git packages from automatically installing Pi peer dependencies and added warnings for extension packages that list host-provided modules in `dependencies`.
- **0.99.0/39** (source line 170): Fixed pinned git extensions loaded with `-e` continuing to use the first downloaded commit after the ref changes.
- **0.84.3/02** (source line 489): **Safer managed updates** — Stage, verify, and atomically activate updates for installer-managed installations. See Install and Manage.
- **0.84.3/15** (source line 511): Changed experimental installer-managed installations so `pi update` stages, verifies, and atomically activates the selected release in place. See Install and Manage.
- **0.84.3/51** (source line 550): Fixed npm package update checks treating older registry versions as available updates, preventing `pi update` from downgrading already-newer installed packages.

</details>

### L7 — Runtime-authenticated small model calls are already used

**Upstream:** 0.86.0 adds `ctx.modelRegistry.stream()`/`streamSimple()`.
**Local evidence:** `packages/ext/automode/index.ts` and `packages/ext/session-tracker/index.ts` already call `modelRegistry.streamSimple()` using captured registry/model dependencies. `small-model.ts` resolves configured cheap models.
**Next action:** retain this auth-resolving seam rather than duplicating token resolution. The high-level runtime accepts legacy context-shaped convenience input and normalizes it; this is distinct from the low-level custom-provider `TranscriptContext` migration.

<details>
<summary>1 classified upstream entries</summary>

- **0.86.0/13** (source line 304): Added `ctx.modelRegistry.stream()` and `streamSimple()` for extension model calls through configured providers with resolved authentication.

</details>

### L8 — Restorable in-memory sessions are already used

**Upstream:** 0.85.0 adds `SessionManager.inMemory(cwd, header, entries)` restoration.
**Local evidence:** `packages/ext/subagents/agent-runner.ts` uses it for persisted conversations and forked parent entries; it does not assign messages to restore history.
**Next action:** retain the existing restoration path and residency/fork tests. Do not replace it with `agent.state.messages` assignment.

<details>
<summary>2 classified upstream entries</summary>

- **0.85.0/03** (source line 393): **Restorable in-memory sessions** — Resume externally stored session entries through the SDK. See Session Management.
- **0.85.0/04** (source line 397): Added `SessionManager.inMemory()` support for restoring externally managed session entries.

</details>

### L9 — Public wait/failure events can improve tracker precision

**Upstream:** 0.84.3 adds `session_compact_failed`; 0.84.4 adds `ui_prompt_start`/`ui_prompt_end`.
**Local evidence:** `packages/ext/session-tracker/index.ts` tracks approval waits with `bites:bash_gate` and compaction completion with `session_compact`, abort signals and `agent_settled`; its comments explicitly cover failed compactions with no success event. `notifications.ts` also observes permission/agent events.
**Next action:** use public UI prompt events if tracker coverage is expanded beyond bash dialogs; distinguish permission prompts from ordinary input. Consider `session_compact_failed` for earlier failure cleanup, retaining generation/count handling so overlapping work is not marked idle. Existing fallback cleanup is not automatically broken.

<details>
<summary>4 classified upstream entries</summary>

- **0.84.4/02** (source line 441): **Extension UI prompt events** — Integrations can distinguish active agent work from time spent waiting for `ctx.ui` prompts. See Extension UI prompt events.
- **0.84.4/08** (source line 450): Added `ui_prompt_start` and `ui_prompt_end` extension events so host integrations can distinguish active agent work from waiting on user-facing `ctx.ui` prompts.
- **0.84.3/09** (source line 502): Added `session_compact_failed` extension events so compaction failures and aborts expose their reason, retry state, source, and error message to handlers.
- **0.84.3/49** (source line 548): Added `session_compact_failed` extension events so compaction failures and aborts expose their reason, retry state, source, and error message to handlers.

</details>

### L10 — Auth preflight can make live checks cheaper and clearer

**Upstream:** 0.84.1 adds `pi auth check`.
**Local evidence:** `README.md` and `docs/code-mode-contract/` distinguish verified routes from unverified direct OpenAI subscription usage/web search; ordinary tests avoid paid review calls.
**Next action:** preflight the exact provider/model before optional live smoke tests. Never log credential-emitting output or treat auth readiness as proof that web-search/usage routes work.

<details>
<summary>2 classified upstream entries</summary>

- **0.84.1/02** (source line 629): **Authentication readiness checks** — Use `pi auth check` to verify provider or model credentials, optionally emitting the resolved credential.
- **0.84.1/06** (source line 636): Added `pi auth check` provider/model auth preflight with optional credential output.

</details>

### L11 — Terminate blocked batches only when denial semantics require it

**Upstream:** 0.84.1 adds `terminate` to blocked `tool_call` results.
**Local evidence:** `packages/ext/bash-gate/index.ts` returns `{ block: true, reason }`, currently allowing the model to explain/recover from denial; subagent operations have their own cancellation semantics.
**Next action:** add terminate only for a deliberate stop-the-run policy. Ordinary approval denials should retain their current explanation/recovery behavior; no blanket change is needed.

<details>
<summary>2 classified upstream entries</summary>

- **0.84.1/04** (source line 631): **Terminating blocked tool calls** — Extension `tool_call` handlers can stop all-terminating batches without another model call. See Tool Events.
- **0.84.1/07** (source line 637): Added `terminate` support to blocked extension `tool_call` events so all-terminating batches can skip the automatic follow-up model call. See Tool Events.

</details>

## Watch

### W11 — Respect additions on reload in adapter selection

**Upstream:** 0.99.2 enables newly added `defaultTools` on `/reload` while preserving existing selections and explicit CLI overrides.
**Local evidence:** `packages/ext/codex-adapter/activation.ts:reconcileTools()` snapshots `selection.tools` once, then adds only `exec`/`wait` to that snapshot. Owned nested membership depends on the snapshot. `code-mode/registration.ts` reconciles on lifecycle events, but current tests run with a 0.99.1 host.
**Next action:** run a 1.0 regression that adds a previously disabled owned nested tool through `defaultTools`, reloads, and confirms adapter membership without reviving intentionally disabled capabilities. Determine whether reload reconstructs the extension state in every supported integration before changing this code. This is a focused compatibility risk, not a proven reload failure.

<details>
<summary>2 classified upstream entries</summary>

- **0.99.2/04** (source line 68): `/reload` enables tools newly added to the `defaultTools` setting. See Tools.
- **0.99.2/09** (source line 76): `/reload` now enables tools newly added to the `defaultTools` setting. Tools removed from it stay enabled, tools turned off during the session stay off unless newly added, and `--tools`, `--no-tools`, and `--no-builtin-tools` still override the setting.

</details>

### W1 — Provider catalogs, auth, reasoning and retry behavior

**Upstream:** 0.84.1–1.0 update provider/model catalogs, defaults, auth, reasoning replay, request fields and retries.
**Local evidence:** `packages/ext/subagents/model-resolver.ts`, `small-model.ts`, and `subagents/agent-runner.ts` resolve arbitrary configured providers through Pi. `codex-adapter/activation.ts` gates model IDs; `codex-account.ts`, `footer/index.ts`, and `codex-adapter/web-run/` distinguish direct OpenAI from legacy Codex credentials. `README.md` already documents GPT-6.1 Sol and legacy-account usage/web limitations. There is no local implementation of the listed low-level provider transports.
**Next action:** accept upstream fixes without copying transports. Rerun selected provider smokes when upgrading or changing defaults, especially GPT-6.1 Sol on direct OpenAI, legacy Codex and Copilot. Keep legacy usage/search auth separate; new login/catalog support does not verify those endpoints. Do not add support for every new model by hand.

<details>
<summary>131 classified upstream entries</summary>

- **1.0.0/05** (source line 23): **Anthropic copy code login** — Sign in when the browser runs on another machine. See Authenticate interactively.
- **1.0.0/11** (source line 32): Added a copy code login method to Anthropic `/login` for headless setups where the browser runs on another machine.
- **0.99.2/03** (source line 67): Anthropic workload identity federation from the Anthropic SDK environment variables. See Use an API key from the environment.
- **0.99.2/08** (source line 75): Added Anthropic workload identity federation from the `ANTHROPIC_FEDERATION_RULE_ID`, `ANTHROPIC_ORGANIZATION_ID`, and `ANTHROPIC_IDENTITY_TOKEN_FILE` environment variables (see Providers).
- **0.99.2/13** (source line 86): Fixed new sessions intermittently ignoring the saved default model, or warning that no models are available, when it belongs to an extension-registered native provider with a stored credential.
- **0.99.2/18** (source line 91): Fixed model lookups slowing down for providers with a refreshed pi.dev catalog, because merging remote catalog models took quadratic time.
- **0.99.2/20** (source line 93): Fixed context overflow detection for Z.AI CN endpoint `Prompt exceeds max length` errors.
- **0.99.2/21** (source line 94): Fixed Anthropic requests failing when a tool schema uses keywords Anthropic strict tool use rejects, such as `minimum`/`maximum`; such tools are now sent non-strict.
- **0.99.2/22** (source line 95): Fixed provider retries firing immediately when a `Retry-After` header contains an unparseable date; they now use exponential backoff.
- **0.99.1/01** (source line 105): **GPT-6.1 Sol** — Available on OpenAI, Azure OpenAI, and OpenAI Codex, and now the default OpenAI Codex model. See Select a model.
- **0.99.1/02** (source line 109): Added GPT-6.1 Sol (`gpt-6.1-sol`) to the OpenAI, Azure OpenAI Responses, and OpenAI Codex providers.
- **0.99.1/03** (source line 113): Changed the default OpenAI Codex model to GPT-6.1 Sol (`gpt-6.1-sol`).
- **0.99.1/04** (source line 117): Fixed `/login` with OpenAI failing in the bundled release with a missing `openai-chatgpt.js` module error.
- **0.99.0/03** (source line 125): **Sign in with ChatGPT** — Use a ChatGPT subscription with the OpenAI provider through `/login openai`. See Authenticate interactively.
- **0.99.0/10** (source line 135): Added Sign in with ChatGPT to the OpenAI provider in `/login`, which uses a ChatGPT subscription with the OpenAI API. Pi stores a stable `deviceId` in the global settings for this login and omits it from bug reports.
- **0.99.0/19** (source line 144): Added `types=chat,image,classifier` to pi.dev model catalog requests so remote refreshes overlay every supported model type; entries of unknown model types are ignored.
- **0.99.0/22** (source line 147): Added inherited Claude Sonnet 5.5 support for Anthropic with adaptive thinking and a 1M context window.
- **0.99.0/31** (source line 159): Renamed the inherited OpenAI Codex provider to "OpenAI Codex (legacy)"; Sign in with ChatGPT on the OpenAI provider supersedes it.
- **0.99.0/43** (source line 174): Fixed unloaded llama.cpp autoload presets overwriting a cached runtime context window with the GGUF training context.
- **0.99.0/47** (source line 178): Fixed the Fireworks default model pointing at the removed Kimi K2.6 model; it now defaults to Kimi K3.
- **0.99.0/48** (source line 179): Fixed the OpenCode Go default model pointing at the removed Kimi K2.6 model; it now defaults to Kimi K3.
- **0.99.0/49** (source line 180): Fixed the Together default model pointing at the removed Kimi K2.6 model; it now defaults to Kimi K3.
- **0.99.0/58** (source line 189): Fixed inherited model-level `samplingParams` being dropped by direct `stream()`/`complete()` calls on OpenAI-compatible APIs.
- **0.99.0/59** (source line 190): Fixed inherited Mistral GLM requests failing with "Expected at most one leading ThinkChunk" after empty content deltas.
- **0.99.0/61** (source line 192): Fixed inherited Mistral reasoning models ignoring the requested thinking level.
- **0.99.0/62** (source line 193): Fixed inherited OpenCode Zen and OpenCode Go `qwen3.8-flash` thinking being replayed as plain text on later turns.
- **0.99.0/63** (source line 194): Fixed inherited OpenAI Responses streams from servers that omit `output_index`, such as llama.cpp, running mixed-up tool calls; such streams now end with an error.
- **0.99.0/64** (source line 195): Fixed inherited Anthropic and OpenAI Codex browser sign-in waiting indefinitely after the provider redirected with an authorization error, and Anthropic sign-in failing when its callback port is in use.
- **0.99.0/65** (source line 196): Fixed inherited GitHub Copilot Claude Opus 5.5 offering unsupported thinking levels when upstream model metadata is incomplete.
- **0.87.1/01** (source line 202): **Latest frontier models** — Use Claude Opus 5.5, GPT-6 Sol, and GPT-6 Luna through supported providers, including GitHub Copilot. See Choose a Model.
- **0.87.1/02** (source line 203): **Grok 4.7 by default for xAI** — New xAI sessions now default to Grok 4.7. See Provider Authentication.
- **0.87.1/03** (source line 207): Added inherited Claude Opus 5.5, GPT-6 Sol, and GPT-6 Luna support for GitHub Copilot.
- **0.87.1/04** (source line 208): Added inherited GPT-6 Sol and GPT-6 Luna support for OpenAI API keys and OpenAI Codex subscriptions.
- **0.87.1/05** (source line 209): Added inherited Claude Opus 5.5 support for Anthropic with adaptive thinking and a 1M context window.
- **0.87.1/06** (source line 213): Changed the default xAI model to Grok 4.7.
- **0.87.1/09** (source line 219): Fixed inherited image-only user messages being rejected by some OpenAI-compatible providers because they included an empty text part.
- **0.87.1/10** (source line 220): Fixed inherited Anthropic OAuth requests reporting an outdated Claude Code version.
- **0.87.0/24** (source line 258): Fixed inherited unknown OpenAI-compatible Chat Completions endpoints receiving strict tool schemas unless they explicitly advertise support.
- **0.86.1/01** (source line 264): **Meta Muse provider** — Sign in with Meta using `/login meta` or use `META_API_KEY` to access Muse Spark models. See Meta (Muse subscription).
- **0.86.1/02** (source line 268): Added Meta (Muse subscription) login via `/login meta` with automatic Model API key refresh, plus `META_API_KEY` support.
- **0.86.1/07** (source line 279): Fixed inherited z.ai `Prompt too long` errors not being recognized as context overflow.
- **0.86.1/08** (source line 280): Fixed inherited Cerebras models advertising unsupported strict tool schemas, which caused HTTP 400 errors when strict and non-strict tools were mixed.
- **0.86.0/04** (source line 289): **Offline Radius model catalog** — Select Radius models immediately, with cached and live catalogs overlaid when available. See Radius.
- **0.86.0/10** (source line 301): Added inherited native deferred tool loading for Fireworks Messages models. Use `ToolSearch` or `tool_search` as the loader name for prompt-prefix deferral.
- **0.86.0/12** (source line 303): Added the public Radius model catalog for immediate and offline model selection, with cached and live gateway catalogs overlaid when available.
- **0.86.0/15** (source line 306): Added `compat.allowedFallbackModels` configuration for overriding or disabling Anthropic server-side fallback models.
- **0.86.0/29** (source line 326): Fixed GitHub Copilot GPT models, including GPT-6 Astra, using the Chat Completions adapter instead of the required Responses adapter.
- **0.86.0/30** (source line 327): Fixed inherited DeepSeek V4.1 thinking levels on OpenRouter and OpenCode Go preserving provider effort metadata.
- **0.86.0/31** (source line 328): Fixed inherited bodyless HTTP 400/413 errors from non-Cerebras providers being misclassified as context overflow.
- **0.86.0/32** (source line 329): Fixed inherited Vercel AI Gateway replaying unsigned thinking as assistant text.
- **0.86.0/33** (source line 330): Fixed inherited Google Generative AI and Vertex AI using unsupported thinking levels when reasoning is omitted or when model capabilities differ within a Gemini family.
- **0.86.0/34** (source line 331): Fixed inherited Anthropic-compatible relays breaking signed thinking replay when they report a different response model, while preserving fallback pricing.
- **0.86.0/37** (source line 334): Fixed inherited Mistral Medium reasoning requests to use `reasoning_effort` for all reasoning-capable `mistral-medium-*` model IDs instead of the unsupported `prompt_mode`.
- **0.86.0/38** (source line 335): Fixed inherited OpenCode and OpenCode Go requests to send `x-opencode-session` from `sessionId` across all supported API adapters.
- **0.86.0/39** (source line 336): Fixed inherited OpenAI Codex requests to send the model's Off reasoning effort instead of omitting it, while respecting unsupported Off mappings.
- **0.86.0/40** (source line 337): Fixed inherited Fireworks unsigned thinking replay and reasoning effort selection using catalog metadata, with verified DeepSeek V4 and Qwen3.8 fallbacks and removal of redundant GLM 5.2 and Kimi K3 effort aliases.
- **0.86.0/41** (source line 338): Fixed inherited OpenRouter requests to send `x-session-id` from `sessionId` for Chat Completions and Anthropic Messages models when prompt caching is enabled.
- **0.86.0/42** (source line 339): Fixed the inherited DeepSeek catalog to advertise `deepseek-flash` for DeepSeek V4.1 Flash instead of retired Flash aliases, and refreshed DeepSeek pricing metadata.
- **0.86.0/43** (source line 340): Fixed inherited Mistral-hosted GLM-5.2 reasoning requests to use `reasoning_effort` instead of the ignored `prompt_mode`.
- **0.86.0/45** (source line 342): Fixed inherited Baseten requests to send session-affinity headers from `sessionId` for automatic prompt-cache routing.
- **0.86.0/46** (source line 343): Fixed inherited retry classification for Cloudflare 520 responses.
- **0.86.0/47** (source line 344): Fixed inherited retry classification for transient Azure peak-load capacity errors.
- **0.86.0/54** (source line 351): Capped agent-level retry backoff at `retry.maxAgentDelayMs` (60s by default) so long retry runs stay responsive during prolonged transient outages.
- **0.86.0/56** (source line 353): Fixed premature missing-model errors after login by waiting for catalog discovery. Radius now defaults to `balanced`, falling back to the first available Radius model when needed.
- **0.86.0/60** (source line 357): Fixed loaded llama.cpp models with `enable_thinking` chat templates ignoring Pi's thinking level.
- **0.86.0/67** (source line 367): Removed unavailable inherited GPT-5.4 and GPT-5.4 mini models from OpenAI Codex selection.
- **0.85.1/01** (source line 373): **GPT-6 Astra** — Available through OpenAI API keys and OpenAI Codex subscriptions. See API Keys and OpenAI Codex.
- **0.85.1/02** (source line 377): Added GPT-6 Astra for OpenAI API keys and OpenAI Codex subscriptions.
- **0.85.1/07** (source line 385): Fixed long prompt-cache requests for GPT-5.6+ Responses models to use `prompt_cache_options.ttl: "30m"` instead of `prompt_cache_retention: "24h"`.
- **0.85.0/01** (source line 391): **Persistent Claude thinking effort** — Supported Anthropic transports preserve per-turn effort and recover safely from signed-thinking mismatches. See Model Configuration.
- **0.85.0/05** (source line 398): Added inherited OpenAI-compatible `vllmPriority` and `supportsMaxOutputTokens` model settings for vLLM scheduler priority and OpenAI Responses output-token limits.
- **0.85.0/08** (source line 401): Added Meta (Muse subscription) login via `/login meta` with automatic Model API key refresh, plus `META_API_KEY` support.
- **0.85.0/12** (source line 411): Removed the unavailable inherited Grok Build 0.1 model from `/model`.
- **0.85.0/13** (source line 412): Fixed inherited provider streams emitting incompatible event sequences and custom tool-call deltas.
- **0.85.0/15** (source line 414): Fixed the inherited Qwen Token Plan Individual catalog to include Qwen3.8 Flash.
- **0.85.0/16** (source line 415): Fixed inherited OpenAI Codex SSE parsing to process terminal events that are not followed by a blank line.
- **0.85.0/17** (source line 416): Fixed inherited GitHub Copilot Claude Fable 5 requests so selected reasoning levels are sent.
- **0.85.0/18** (source line 417): Fixed inherited Baseten GLM-5.2 models incorrectly advertising image input support.
- **0.85.0/25** (source line 424): Fixed inherited Fireworks GLM models using the wrong API adapter.
- **0.85.0/26** (source line 425): Fixed inherited `NO_PROXY` matching for root domains and subdomains.
- **0.85.0/34** (source line 433): Fixed proxied plain-HTTP provider requests hanging after a tool call by tunneling them with CONNECT.
- **0.84.4/05** (source line 444): **DeepSeek V4 Flash Vision (experimental)** — Use the vision-capable model through the built-in DeepSeek provider. See API Keys.
- **0.84.4/06** (source line 448): Added `supportsMidConvoEffort` to custom Anthropic Messages model compatibility settings.
- **0.84.4/10** (source line 452): Added inherited experimental vision-capable `deepseek-v4-flash-vision-exp` model support.
- **0.84.4/24** (source line 472): Fixed Google Vertex requests failing with `HttpsProxyAgent is not a constructor` when the bundled Node.js runtime uses an HTTP(S) proxy.
- **0.84.4/25** (source line 473): Fixed saving a default model from a non-empty model scope so it remains available in that scope.
- **0.84.4/27** (source line 475): Fixed inherited OpenAI-compatible streams serializing thinking signatures repeatedly during streaming.
- **0.84.4/30** (source line 478): Fixed inherited Cloudflare AI Gateway catalogs omitting supported `workers-ai/*` passthrough models.
- **0.84.4/31** (source line 479): Fixed inherited OpenAI-compatible reasoning replay to merge consecutive streamed text and summary `reasoning_details` deltas.
- **0.84.4/32** (source line 480): Fixed inherited OpenRouter reasoning controls so reasoning-mandatory models do not receive `effort: "none"`.
- **0.84.4/33** (source line 481): Fixed inherited OpenAI-compatible Chat Completions ignoring an explicitly requested `toolChoice` when no tools are defined.
- **0.84.4/34** (source line 482): Fixed inherited fragmented Mistral tool calls splitting when continuation chunks omit the tool-call ID.
- **0.84.3/03** (source line 490): **Model and thinking controls** — Select thinking levels with `/thinking`, search defaults, keep selections session-scoped, and persist them explicitly with Ctrl+S. See Models and Thinking.
- **0.84.3/06** (source line 499): Added a `/thinking` selector and searchable default choices to the model and thinking selectors; Ctrl+S saves the selected model as the global default. See Models and Thinking.
- **0.84.3/10** (source line 503): Added inherited provider-neutral `toolChoice` support to simple stream requests.
- **0.84.3/11** (source line 504): Added inherited automatic Anthropic server-side refusal fallback for supported first-party models, including returned-model usage pricing.
- **0.84.3/12** (source line 505): Added inherited configurable OpenAI-compatible thinking-token budget fields for vLLM, Qwen/SGLang, and llama.cpp servers. See OpenAI Compatibility.
- **0.84.3/13** (source line 506): Added inherited China-specific ZAI Coding Plan models, including GLM-4.6V vision support and API-equivalent usage cost estimates.
- **0.84.3/14** (source line 507): Added inherited `deepseek-v4-pro-0813` support to the Qwen Token Plan Individual catalog.
- **0.84.3/16** (source line 512): Changed inherited built-in xAI models to use the Responses API with encrypted reasoning replay and made Grok 4.6 the default xAI model.
- **0.84.3/17** (source line 513): Changed inherited Anthropic, Azure OpenAI, Google, Mistral, and OpenAI adapters to send Pi's default `User-Agent` unless overridden.
- **0.84.3/26** (source line 525): Fixed `models.json` typings omitting the documented OpenAI-compatible `compat.supportsFinishReason` provider and model override.
- **0.84.3/27** (source line 526): Fixed `/model` and `/thinking` selections being persisted globally unless explicitly saved with Ctrl+S.
- **0.84.3/34** (source line 533): Fixed the default Cerebras model referencing an unavailable Z.AI model.
- **0.84.3/35** (source line 534): Fixed inherited OpenAI-compatible Chat Completions reasoning replay to preserve and resend assistant-level `reasoning_details` verbatim and in order.
- **0.84.3/36** (source line 535): Fixed inherited Anthropic server-side fallback responses being priced with the requested model instead of the returned fallback model.
- **0.84.3/37** (source line 536): Fixed inherited GitHub Copilot login triggering model-policy rate limits by limiting policy updates, retrying model discovery once, and honoring server retry delays.
- **0.84.3/38** (source line 537): Fixed inherited Amazon Bedrock dropping and failing to replay opaque redacted reasoning from non-Anthropic models.
- **0.84.3/39** (source line 538): Fixed inherited Z.AI Coding Plan models deriving incomplete reasoning-effort metadata, including missing GLM-5.3 low, high, and max levels.
- **0.84.3/40** (source line 539): Fixed inherited DeepSeek V4 Flash on OpenCode and OpenCode Go omitting its supported low thinking level.
- **0.84.3/41** (source line 540): Fixed inherited Azure OpenAI Responses ignoring `toolChoice` in provider-specific stream requests.
- **0.84.3/42** (source line 541): Fixed inherited Amazon Bedrock response hooks receiving only a synthesized request id instead of the raw response headers.
- **0.84.3/44** (source line 543): Fixed inherited Google custom models ignoring `thinkingLevelMap`, which dropped extended thinking controls.
- **0.84.3/52** (source line 551): Fixed built-in llama.cpp models disappearing from `/model` when `/llama` refreshed a configured server under `PI_OFFLINE`, and included idle-slept `sleeping` router models plus autoloadable unloaded presets in the selectable catalog.
- **0.84.3/54** (source line 553): Fixed Z.AI Coding Plan defaults referencing the removed GLM-5.1 model.
- **0.84.3/55** (source line 554): Fixed repeated ambiguous truncated-response recovery being mislabeled as context overflow.
- **0.84.3/59** (source line 558): Fixed llama.cpp login guidance to direct users to `/llama` before `/model` when no local models are loaded.
- **0.84.3/60** (source line 559): Fixed hung pi.dev model catalog requests consuming the entire refresh deadline without retrying.
- **0.84.3/61** (source line 560): Fixed inherited Xiaomi model catalogs listing shut-down MiMo V2 models in `/model` and `--list-models`.
- **0.84.2/14** (source line 588): Changed inherited Kimi Coding requests to use pi's runtime `User-Agent` header.
- **0.84.2/15** (source line 589): Replaced the inherited Mistral SDK transport with a native Chat Completions HTTP stream, eliminating its generated client and schema runtime overhead.
- **0.84.2/22** (source line 599): Fixed opening a model selector immediately after startup cancelling and restarting the in-progress model catalog refresh.
- **0.84.2/23** (source line 600): Fixed inherited GitHub Copilot login triggering API rate limits while enabling model policies by limiting concurrent policy updates.
- **0.84.2/34** (source line 611): Fixed inherited OpenAI Responses function and custom tool calls losing namespaces during streaming, proxying, and replay.
- **0.84.2/35** (source line 612): Fixed inherited upstream request buffer failures not triggering automatic assistant retries.
- **0.84.2/36** (source line 613): Fixed inherited built-in and custom DeepSeek API models sending output limits through an unsupported field.
- **0.84.2/37** (source line 614): Fixed inherited Amazon Bedrock replay rejecting tool arguments that contain empty object keys while preserving all valid nested values.
- **0.84.2/38** (source line 615): Fixed inherited DeepSeek compatibility detection for base URLs whose hostname contains uppercase letters.
- **0.84.2/39** (source line 616): Fixed inherited Google Generative AI and Vertex AI responses with tool calls incorrectly treating output-limit or provider-error stops as normal tool use.
- **0.84.1/01** (source line 628): **Qwen Token Plan Individual** — Use the built-in provider for models documented for Individual subscriptions. See API Keys.
- **0.84.1/05** (source line 635): Added Qwen Token Plan Individual as a built-in provider with its documented subscription model catalog and the shared international `QWEN_TOKEN_PLAN_API_KEY`. See API Keys.

</details>

### W2 — Terminal, theme, clipboard and fullscreen interactions

**Upstream:** 0.84.1–1.0 change terminal capabilities, key defaults, themes, scroll/selection, Markdown/LaTeX and images.
**Local evidence:** `packages/ext/footer/`, `view/index.ts`, `usage-dashboard.ts`, `subagents/ui/`, and custom tool renderers use Pi TUI components/theme methods. There is no custom editor or clipboard backend. `subagents/ui/viewer-keys.ts` uses host keybindings; some visible shortcut hints elsewhere remain literal.
**Next action:** use host theme/keybinding/capability APIs and keep manual fullscreen/narrow-terminal smoke coverage. Do not duplicate clipboard, image transport or LaTeX fixes. Review literal hints if Windows/WSL becomes a supported adapter platform; the native adapter currently documents Linux-only binaries.

<details>
<summary>72 classified upstream entries</summary>

- **1.0.0/29** (source line 56): Fixed the system theme making pastel palettes such as Catppuccin Frappe much more vivid; palette colors now keep their chroma.
- **1.0.0/30** (source line 57): Fixed slash command autocompletion not triggering when the input starts with whitespace.
- **1.0.0/31** (source line 58): Fixed color bleeding past mouse selections and search highlights in fullscreen mode when a styled token ends at the highlight boundary.
- **0.99.0/02** (source line 124): **System theme** — Pi's colors now come from your terminal's own palette by default. See Use your terminal's colors.
- **0.99.0/11** (source line 136): Added the `system` theme, now the default, which derives pi's colors from the terminal's reported foreground, background, and ANSI palette and rebuilds them when the terminal switches between light and dark. See Use your terminal's colors.
- **0.99.0/12** (source line 137): Added `#rgb`, `oklch()`, and `okhsl()` colors and an optional `appearance` field to theme files, and `theme.style()`, `theme.colors`, and `theme.appearance` for extensions. See Themes and TUI.
- **0.99.0/15** (source line 140): Added the `fullscreenWheelScrollLines` setting and `/settings` entry for fullscreen mouse-wheel scrolling. The default `"auto"` accelerates fast wheel spins outside local macOS terminals.
- **0.99.0/29** (source line 157): Changed the built-in `dark` and `light` themes to the revised pi colors, written in OKHSL.
- **0.99.0/30** (source line 158): Changed light/dark terminal detection to use the reported background color first, then the terminal's light/dark report, then `COLORFGBG`. The first-time setup no longer shows the detected appearance.
- **0.99.0/32** (source line 160): Changed inherited terminal detection to treat `TERM=*-direct` as truecolor.
- **0.99.0/44** (source line 175): Fixed custom themes ignoring `terminal.trueColor` and other terminal capability overrides and rendering with 256 colors.
- **0.99.0/45** (source line 176): Fixed pasting files copied in Finder inserting the file icon image instead of the file paths; paths are quoted in bash mode.
- **0.99.0/46** (source line 177): Fixed the startup header, loaded resources, and chat notices keeping their old colors after a theme change.
- **0.99.0/54** (source line 185): Fixed inherited image stretching in terminals that use the Kitty graphics protocol.
- **0.99.0/55** (source line 186): Fixed inherited shell cursor staying hidden after exit when an extension closed an overlay during shutdown.
- **0.99.0/56** (source line 187): Fixed inherited keyboard input being lost after a mouse click in a `/settings` submenu closed it.
- **0.86.1/06** (source line 278): Fixed clipboard copy failing in containers and WSL without WSLg by restoring the OSC 52 fallback when no display is available, and added a verified Windows clipboard backend for WSL.
- **0.86.0/11** (source line 302): Added click toggling for branch summaries, compaction summaries, and skill invocation entries.
- **0.86.0/23** (source line 317): Replaced the external native clipboard dependency with bundled asynchronous macOS, Windows, and X11 helpers while preserving platform command and OSC 52 fallbacks.
- **0.86.0/25** (source line 319): Moved compaction, branch summarization, and retry spinners into the editor border alongside the working indicator. Custom editors use the same embedding opt-in for all status spinners.
- **0.86.0/53** (source line 350): Fixed local clipboard failures reporting success when the terminal ignored the fallback OSC 52 write, and added platform-specific setup guidance when no clipboard backend works.
- **0.86.0/57** (source line 354): Fixed fullscreen mode reserving a blank row for custom footers that render zero rows.
- **0.86.0/62** (source line 359): Fixed asynchronous Kitty image conversion replacing newer partial tool output images.
- **0.86.0/65** (source line 362): Fixed inherited LaTeX legacy font switches falling back to raw source, centered `cases` layouts around surrounding equations, and vertically laid out unsupported and nested display scripts.
- **0.86.0/66** (source line 363): Fixed inherited fullscreen Kitty images being erased by later row clears in WezTerm.
- **0.85.1/03** (source line 378): Added five-times-faster mouse wheel scrolling while holding Alt in fullscreen mode.
- **0.85.1/04** (source line 382): Fixed configurable save keybindings in the model and thinking selectors.
- **0.85.1/06** (source line 384): Fixed mouse hover changing selection and recentering autocomplete and settings lists, causing clicks to target a different item.
- **0.85.0/02** (source line 392): **Fullscreen transcript controls** — Jump to the latest message from a scrolled transcript and use the embedded working indicator. See TUI Fullscreen Viewport.
- **0.85.0/06** (source line 399): Added inherited LaTeX rendering for relational algebra join symbols.
- **0.85.0/07** (source line 400): Added a clickable "Jump to latest message" label with the `tui.altScreen.bottom` shortcut to the fullscreen transcript while it is scrolled up.
- **0.85.0/09** (source line 405): Moved the streaming working indicator into the default editor border and matched its default spinner and label to the thinking-level border color. Custom editors retain the standalone indicator unless they opt in to embedding it.
- **0.85.0/10** (source line 406): Reduced inherited fullscreen transcript search latency on large transcripts by caching unchanged search results, indexing ASCII runs, and limiting highlight work to visible matches.
- **0.85.0/28** (source line 427): Fixed inherited terminal startup under restricted seccomp policies that reject the `SIGWINCH` self-signal.
- **0.85.0/29** (source line 428): Fixed inherited Zed terminal image capability detection.
- **0.85.0/30** (source line 429): Fixed drag selection continuing over the fullscreen editor.
- **0.84.4/01** (source line 440): **Terminal capability overrides** — Override detected terminal hyperlink, image, and truecolor support. See Capability Overrides.
- **0.84.4/04** (source line 443): **Fullscreen selection copy controls** — Disable automatic selection copying in fullscreen mode and use Ctrl+X to copy the active selection. See UI & Display.
- **0.84.4/13** (source line 455): Added environment variables and advanced settings for overriding auto-detected terminal hyperlink, image, and truecolor capabilities.
- **0.84.4/14** (source line 456): Added `fullscreenCopyOnSelect` to disable automatic fullscreen selection copy; when disabled, `Ctrl+X` copies the active text selection before falling back to the last assistant message, while `/tree` still copies the selected message.
- **0.84.4/15** (source line 460): Changed fullscreen scrollbars to reveal on pointer entry, support optional `scrollbarTrack` and `scrollbarThumb` theme colors with muted and text fallbacks, keep one thumb color across normal and expanded states, and support track-click jumping.
- **0.84.4/16** (source line 461): Changed fullscreen transcript search arrows to underline on hover and capitalized the search placeholder.
- **0.84.4/17** (source line 462): Changed selectors in `/thinking`, `/model`, `/scoped-models`, `/trust`, per-model thinking settings, and theme settings to keep active options marked while browsing. `/scoped-models` now uses consistent per-item toggles and strikes through unavailable models.
- **0.84.4/18** (source line 466): Fixed toggling thinking visibility clearing partial output from running Bash tools.
- **0.84.4/28** (source line 476): Fixed inherited main-screen rendering crashing when image-heavy output exceeded V8's string length limit.
- **0.84.4/29** (source line 477): Fixed inherited fullscreen double-click word selection splitting paths and kebab-case tokens on `/` and `-`.
- **0.84.3/18** (source line 514): Changed Windows and WSL keybinding defaults to avoid terminal-reserved shortcuts for image paste, model cycling, editor undo, fullscreen transcript navigation and search, and message queueing.
- **0.84.3/56** (source line 555): Fixed duplicate fullscreen right-click paste in VS Code-based terminals on Windows.
- **0.84.3/57** (source line 556): Fixed inherited padded text exceeding narrow terminal widths.
- **0.84.3/58** (source line 557): Fixed inherited wrapped Markdown table links leaking color into borders and neighboring cells, including tables inside blockquotes.
- **0.84.2/01** (source line 569): **Fullscreen transcript search** — Search and navigate matches in fullscreen mode. See TUI Fullscreen Viewport.
- **0.84.2/03** (source line 571): **Configurable fullscreen exit output** — Print the transcript or only a resume hint on exit. See Interactive Mode.
- **0.84.2/04** (source line 575): Added per-block fullscreen mouse expansion for thinking sections and tool results, while preserving drag selection and link activation.
- **0.84.2/05** (source line 576): Added fullscreen transcript search with `Ctrl+Shift+F`, incremental match highlighting, configurable search match theme colors, and next/previous navigation with `Enter`/`Ctrl+G` and `Shift+Enter`/`Ctrl+Shift+G`.
- **0.84.2/07** (source line 578): Added a fullscreen exit output setting to choose between printing the final transcript and only a session resume hint.
- **0.84.2/09** (source line 580): Added `--use-theme <name[/name]>` to choose an initial per-run interactive theme without changing saved settings.
- **0.84.2/13** (source line 584): Added inherited unbound single-line transcript scrolling actions for fullscreen mode. See TUI Fullscreen Viewport.
- **0.84.2/18** (source line 592): Reduced inherited fullscreen rendering allocation churn by painting full-width layout rows directly instead of recompositing them on every frame.
- **0.84.2/24** (source line 601): Fixed fullscreen transcript search snapping back to the current match during manual scrolling and fragmented mouse input leaking into the search query.
- **0.84.2/25** (source line 602): Fixed inherited required LaTeX arguments starting on a new line being parsed as empty.
- **0.84.2/40** (source line 617): Fixed inherited fullscreen mouse drag selection and OSC 8 link activation in terminals that report generic SGR mouse release button codes.
- **0.84.2/41** (source line 618): Fixed inherited focused fullscreen overlays not receiving mouse wheel or viewport scroll keys such as PageUp and PageDown.
- **0.84.2/42** (source line 619): Fixed inherited LaTeX control spaces split across line endings causing complete expressions to fall back to raw source.
- **0.84.2/43** (source line 620): Fixed split `Alt+Enter` input over SSH being misread as Escape, added `PI_TUI_ESC_TIMEOUT` for high-latency terminals, and limited that timeout to lone Escape input.
- **0.84.2/44** (source line 621): Fixed inherited idle fullscreen sessions repainting and clearing text selection when the terminal loses focus.
- **0.84.2/45** (source line 622): Fixed fullscreen selection copy to use the host clipboard and report failure instead of claiming success when OSC 52 is unsupported.
- **0.84.1/03** (source line 630): **Improved fullscreen interaction** — Select words and paragraphs with multiple clicks and configure half-page transcript scrolling. See TUI Fullscreen Viewport.
- **0.84.1/08** (source line 638): Added inherited double-click word and whitespace selection, granularity-aware drag selection, and triple-click paragraph selection in fullscreen mode.
- **0.84.1/09** (source line 639): Added inherited unbound half-page transcript scrolling actions for fullscreen mode. See TUI Fullscreen Viewport.
- **0.84.1/14** (source line 650): Fixed right-click not pasting clipboard text in fullscreen mode on Windows.
- **0.84.1/16** (source line 652): Fixed inherited LaTeX relation, multiplication, and named-operator spacing, and matrix composition with stacked fractions, operator limits, and adjacent matrices.
- **0.84.1/17** (source line 653): Reduced inherited fullscreen mouse event volume under tmux, Zellij, and GNU Screen by using button-motion tracking instead of all-motion tracking.

</details>

### W3 — Native codemode/MCP versus the pinned V8 adapter

**Upstream:** 0.99.0–1.0 add native QuickJS codemode/MCP, deferred discovery, namespace normalization, auth hardening, structured shell results, image generation and leaner prompts/errors.
**Local evidence:** `packages/ext/codex-adapter/code-mode/` exposes persistent V8 `exec`/`wait` and a five-tool owned bridge; it does not implement native `models`, `searchTools`, or `describeNamespace`. `activation.ts` preserves unrelated active tools. No local MCP server configuration, OAuth store or native codemode script was found. Pi 1.0 native codemode cannot call inactive default-direct tools; tool_search searches only codemode/deferred tools. Current adapter-owned default-direct registrations therefore remain isolated when projected inactive.
**Next action:** test native codemode/MCP alongside the adapter if users enable them. Preserve selection/trust boundaries; do not change owned tools to codemode/deferred exposure casually. Do not port native `typeof tools.name` recovery rules, 1 MiB shell structure, names or `models.generateImages()` claims into the different V8 contract. Native OAuth fixes require no local migration. Consider native codemode for users who need MCP discovery, but it is not an automatic replacement for yielded persistent cells.

<details>
<summary>37 classified upstream entries</summary>

- **1.0.0/02** (source line 20): **Leaner codemode** — About 40% fewer prompt tokens, and errors that tell the model how to recover. See Codemode.
- **1.0.0/03** (source line 21): **Image generation in codemode** — Scripts call `models.generateImages()` with the session's credentials. See Generate images and Use image models.
- **1.0.0/04** (source line 22): **Radius in `/login`** — Sign in with Radius and set up its MCP server in one step. See Radius.
- **1.0.0/06** (source line 24): **MCP OAuth hardening** — `oauth.authServerMetadataUrl`, RFC 9207 `iss` checks, credentials per server, and step-up sign-in that keeps granted scopes. See Authenticate with OAuth.
- **1.0.0/08** (source line 29): Added an `oauth.authServerMetadataUrl` setting for MCP servers that advertise a wrong OAuth authorization server or none. Pi uses the configured metadata document instead of discovery.
- **1.0.0/10** (source line 31): Added `models.generateImages()` to codemode scripts. It runs image models such as OpenRouter's with the session's credentials and returns base64 image blocks that `image()` attaches to the result; usage counts toward the session cost like `models.classify()`. Extensions can call `ctx.modelRegistry.generateImages()`. See Use image models.
- **1.0.0/13** (source line 37): `/login` now offers "Sign in with Radius" at the top level, as the last option, with its status. After a Radius sign-in, `/login` offers to configure the Radius MCP server in the global `mcp.json` with `"auth": { "provider": "radius" }` and reloads. Cancelling a login returns to the menu it was started from.
- **1.0.0/15** (source line 39): MCP OAuth credentials are now stored per server name and URL, so MCP servers with the same URL can sign in with different accounts. Credentials stored by URL alone move to the first server that uses them.
- **1.0.0/16** (source line 40): Codemode costs far fewer prompt tokens: with the default tools and codemode active, a GPT-5.6 request shrinks from about 5,300 to 3,300 tokens. The `codemode` description lists the script globals in one line each and points to the new Codemode reference for the `models` API, which the model reads when it needs it. Declared tools say in one line how scripts call them and what the call resolves to, instead of repeating their full declaration, and the system prompt's codemode guidance and MCP server section are shorter.
- **1.0.0/17** (source line 41): Codemode errors now say how to recover: reading a tool or `models` member that does not exist names the close matches (`tools.Bash` suggests `tools.bash`), `models.classify()` and `models.generateImages()` reject malformed arguments with the expected shape, an unknown model points to `models.getAvailableOfType()`, an oversized `store()` value explains what the store is for, and a script that generates images without showing them gets a note. Scripts that probed for a tool with `typeof tools.name` must use `"name" in tools`.
- **1.0.0/20** (source line 47): Fixed MCP OAuth sign-in accepting an authorization response whose `iss` parameter names another authorization server; the code is now rejected before it is exchanged (RFC 9207).
- **1.0.0/21** (source line 48): Fixed MCP OAuth sign-in failing with `Invalid scope` when the token response contains `"scope": ""`, and similar failures for other empty or `null` optional OAuth fields.
- **1.0.0/22** (source line 49): Fixed the sign-in URL printed by `/mcp login` not being clickable when it wraps.
- **1.0.0/24** (source line 51): Fixed MCP servers that ask for more scope (`insufficient_scope`) requesting sign-in over and over. The new sign-in requested only the missing scopes, so the new token lost access the previous one had; it now keeps the granted scopes.
- **1.0.0/28** (source line 55): Fixed deferred MCP tools that `tool_search` loaded being dropped on resume and `/reload` even when their server reconnected before the next prompt, because the session restored its tools before the MCP servers reconnected.
- **0.99.2/01** (source line 65): MCP servers stay out of the way: servers with the default `codemode` exposure are no longer listed in the `codemode` description and no longer block the first prompt. They appear in a short system prompt section, and scripts find their tools with `searchTools()` and `describeNamespace()`. See Control tool exposure.
- **0.99.2/02** (source line 66): More MCP authentication options: `oauth.clientName` for servers that only accept known OAuth clients, and `"auth": { "provider": "<provider>" }` to authenticate HTTP servers with a provider's `/login` token. See Authenticate with OAuth.
- **0.99.2/05** (source line 72): Added a `description` field for MCP servers (`pi mcp add --description`), shown with the server in the system prompt and used to rank its tools in tool search, and a `describeNamespace(name)` codemode helper that returns a namespace's instructions and tool names. `describeNamespace()` and `searchTools()` accept a namespace as `mcp__dev-radius`, `mcp__dev_radius`, `dev-radius`, or `dev_radius`.
- **0.99.2/06** (source line 73): Added an `oauth.clientName` setting for MCP servers (`pi mcp add --oauth-client-name`) to change the client name sent during OAuth client registration, for servers that only accept known clients.
- **0.99.2/07** (source line 74): Added `"auth": { "provider": "<provider>" }` for HTTP MCP servers to send a provider's current `/login` token as the bearer token instead of using MCP OAuth. The token is read on every request, so provider refreshes apply. Only allowed in the global `mcp.json` and from extensions, and requires https except on loopback hosts.
- **0.99.2/10** (source line 80): MCP servers with the default `codemode` exposure no longer appear in the `codemode` description; scripts find them with `searchTools()`. `codemode-deferred` is now an alias for `codemode`. Use `direct` exposure for tools the model should see without searching.
- **0.99.2/11** (source line 81): The `codemode` description no longer includes deferred tools, tool counts, or MCP server instructions, so it no longer changes when MCP servers connect or change their tools. The `tool_search` description no longer lists the servers whose tools it can load, for the same reason. Servers are listed instead in an `mcp_servers` system prompt section with a one-line summary, updated at the start of each prompt; a changed section is appended to the conversation. Scripts read server instructions with `describeNamespace()`.
- **0.99.2/12** (source line 82): The first prompt no longer waits for MCP servers without `direct` tools. They connect in the background and are waited for when a codemode script names them, a script searches tools, or `tool_search` runs.
- **0.99.2/15** (source line 88): Fixed codemode `image()` accepting malformed base64 data or unsupported image types, which persisted an invalid image block that made every later provider request fail with HTTP 400.
- **0.99.2/16** (source line 89): Fixed codemode failing to start its script worker from the standalone Windows executable.
- **0.99.2/24** (source line 97): Fixed collapsed `codemode` and MCP tool results filling the screen when the output is one long line, such as minified JSON. Like bash output, the preview is now limited to wrapped lines instead of logical lines.
- **0.99.2/25** (source line 98): Fixed `codemode.mode: "only"` listing `read`, `bash`, `edit`, and `write` in the system prompt's tool list although requests only declare `codemode`.
- **0.99.2/26** (source line 99): Fixed codemode scripts calling the wrong MCP tool when two tool names differ only in `-` and `_`, such as `read-file` and `read_file`. Like in Codex, MCP tool and namespace names now replace `-` with `_` (`mcp__my-server__x` is now `mcp__my_server__x`), colliding tools of a server all get a hash suffix, and server names that differ only in `-` and `_` are rejected.
- **0.99.0/01** (source line 123): **Codemode and MCP** — Connect MCP servers and let models run JavaScript that calls tools in parallel. See MCP Servers and Enable codemode.
- **0.99.0/06** (source line 131): Added codemode, tool search, and MCP support as built-in extensions. The `codemode` tool runs model-written JavaScript in a QuickJS sandbox that calls pi's tools; enable it with `defaultTools` or `--tools` and configure it with `codemode.mode` and `codemode.inlineBudget`. `tool_search` finds tools that are not declared to the model and declares them. MCP servers over stdio or streamable HTTP, with OAuth, come from `mcp.json` (global, or per project once trusted) or `pi.registerMcpServer()` and are managed with `/mcp` and `pi mcp add|remove|list|login|logout`. See MCP Servers and Enable codemode.
- **0.99.0/23** (source line 148): Added a Built-in section in `pi config` to disable the built-in `mcp`, `llama.cpp`, `codemode`, and `tool-search` extensions globally or per project, stored as `-builtin:<name>` in the `extensions` setting. SDK inline extensions opt in with `builtin: true`.
- **0.99.0/24** (source line 149): Added `+name` and `-name` entries to the `defaultTools` setting to add or remove tools without repeating the defaults, for example `"defaultTools": ["+codemode"]`. Project entries of this form apply on top of the user setting. Documented how to enable `codemode` without MCP and how to use classifier models such as Jev from codemode scripts.
- **0.99.0/36** (source line 164): `bash` and `powershell` structured results, which codemode scripts receive, now hold up to 1 MiB of output instead of the model-facing 2000 lines or 50KB, and add `truncated` and `full_output_path`. Longer output keeps its first and last 512 KiB. Empty output is `""` instead of `(no output)`.
- **0.84.2/02** (source line 570): **Configurable default tools** — Choose startup built-in tools globally or per project. See Tools.
- **0.84.2/08** (source line 579): Added the `defaultTools` setting for configuring the initial built-in tool selection globally or per project.
- **0.84.2/17** (source line 591): Changed inherited OpenAI Responses deferred tool loading to prefer message-anchored `additional_tools` where supported while retaining tool-search and top-level fallbacks.
- **0.84.2/30** (source line 607): Fixed the `defaultTools` setting dropping extension and SDK custom tools when selecting built-in defaults.

</details>

### W4 — Canonical context, prompt persistence and private compaction

**Upstream:** 0.84.3–0.87.0 tighten session restoration, context edits, prompt/tool persistence, compaction, forks, cancellation and settle ordering.
**Local evidence:** `packages/ext/subagents/agent-runner.ts` restores via SessionManager; `automode/index.ts` accounts for context_edit IDs. `auto-compaction.ts` uses a private `_runAutoCompaction`/prepare-next-turn seam plus interactive abort/compact/resume logic. Its post-compaction state.messages slice remains valid in 1.0 because upstream refreshes it from the canonical projection. `ponytail/index.ts`, `inline-references/index.ts`, `subagents/operations.ts`, and `code-mode/registration.ts` return whole systemPrompt strings.
**Next action:** retain context-edit/resume/tree and compaction/cancellation end-to-end checks. Whole systemPrompt overrides are request-local, unlike persisted `event.systemPromptOptions.sections` changes; if resume must preserve an extension section without re-running hooks, migrate that section deliberately. There is no `setSystemPromptSection` API. Evaluate native per-model compaction budgets before extending the private threshold path; remove older-runtime cancellation workarounds only after raising the supported minimum host. Do not classify existing canonical slice reads as forbidden history assignment.

<details>
<summary>33 classified upstream entries</summary>

- **0.99.0/42** (source line 173): Fixed new sessions being lost when pi exits before the first assistant response. The session file is now created when the first user message is sent.
- **0.87.1/07** (source line 217): Fixed split-turn compaction summaries being refused by Claude Fable 5.1 by clearly separating the conversation and using continuation-oriented instructions.
- **0.87.0/01** (source line 226): **Canonical session context and extension boundaries** — Edit model context without rewriting history and add actionable lifecycle hooks. See ContextEditEntry and extension events.
- **0.87.0/05** (source line 233): Added `ContextEditEntry` to the exported `SessionEntry` union. TypeScript consumers with exhaustive entry switches must handle `context_edit`; use `replacement: null` for omission and a content replacement otherwise.
- **0.87.0/06** (source line 234): Made `SessionManager` canonical for `AgentSession` provider context. Assigning `session.agent.state.messages` no longer replaces future request history; restore with `SessionManager.inMemory(cwd, { id }, entries)`, navigate with `session.navigateTree()`, or append through `session.sessionManager` and call `session.refreshContext()`.
- **0.87.0/08** (source line 236): Deferred runs requested from `agent_settled` handlers until all settled handlers finish. Handlers still observe `ctx.isIdle() === true`, but no longer see a reentrant `agent_start` during the same notification dispatch.
- **0.87.0/09** (source line 240): Added append-only model-context edits. For example, `sessionManager.appendContextEdit(entryId, null)` omits one message from future provider context without changing raw history, usage, or UI history.
- **0.87.0/11** (source line 242): Added retain-none compaction input: `sessionManager.appendCompaction(summary, null, tokensBefore)` stores the compaction's own ID as its kept boundary.
- **0.87.0/14** (source line 248): Fixed string context-edit replacements producing invalid assistant and tool-result message content instead of text blocks.
- **0.87.0/15** (source line 249): Fixed context-invisible boundary metadata and replacement edits causing newly appended or replaced input to be summarized before its first provider request.
- **0.87.0/16** (source line 250): Fixed edited-context accounting both discarding valid assistant usage captured after the latest context edit and reusing that usage after a later compaction made it stale.
- **0.87.0/17** (source line 251): Fixed selected error retries and final length/overflow recovery retaining abandoned model attempts in future provider context; post-run recovery omissions are now persisted without hiding raw transcript history or changing queue scheduling.
- **0.86.0/03** (source line 288): **Transcript-aware prompt and tool updates** — Preserve instruction and tool changes across resume and branch navigation while retaining cached prefixes. See `before_agent_start`.
- **0.86.0/05** (source line 290): **Per-model compaction budgets** — Configure reserved and recent-token budgets by model. See Per-model overrides.
- **0.86.0/09** (source line 300): Added transcript-backed mid-conversation system prompt and tool changes so instruction and tool updates survive resume and branch navigation while preserving cached prefixes on supported models. See `before_agent_start` and Entry Types.
- **0.86.0/14** (source line 305): Added per-model `reserveTokens` and `keepRecentTokens` settings through `compaction.modelOverrides`, with ordinary compaction settings as fallback.
- **0.86.0/48** (source line 345): Fixed session tree navigation racing with active compaction and replacing its progress UI.
- **0.86.0/51** (source line 348): Fixed mid-run threshold compaction silently skipping oversized trailing tool results.
- **0.86.0/59** (source line 356): Fixed `before_agent_start` handlers returning `systemPrompt` (and `forceSystemPrompt`) on models with mid-conversation system messages: the forced prompt is now sent as the provider's leading system prompt instead of being appended as a section patch after the original prompt.
- **0.86.0/61** (source line 358): Fixed cancellation races that could start automatic compaction, leave stale retry state, or miss cancellation while waiting for summarization authentication.
- **0.85.0/22** (source line 421): Fixed imported sessions overwriting an existing session with the same filename.
- **0.85.0/23** (source line 422): Fixed session forks losing their compaction boundary.
- **0.85.0/24** (source line 423): Fixed in-memory session forks before an active turn settled.
- **0.85.0/32** (source line 431): Fixed branch summaries failing when reasoning consumes the previous 2048-token output cap.
- **0.84.4/20** (source line 468): Fixed resumed sessions corrupting the next appended entry when their JSONL file lacks a trailing newline.
- **0.84.4/22** (source line 470): Fixed compaction and branch summaries forcing `toolChoice: "none"`.
- **0.84.4/23** (source line 471): Fixed large tool results crossing the auto-compaction threshold being sent to the provider before compaction. Pi now compacts between tool execution and the next assistant response in the same run, and restores interactive progress when that run resumes.
- **0.84.3/07** (source line 500): Added optional routing session IDs to exported compaction summary helpers so callers can preserve provider routing without enabling prompt cache writes.
- **0.84.3/31** (source line 530): Fixed compaction and branch summarization requests exposing tools to providers.
- **0.84.3/50** (source line 549): Fixed truncated compaction and branch summaries being persisted when generation reaches its output token limit.
- **0.84.3/62** (source line 561): Fixed branch summary entries recording the navigation destination in `fromId` instead of the pre-navigation source leaf.
- **0.84.3/63** (source line 562): Fixed threshold auto-compaction being skipped when providers omit streaming usage data.
- **0.84.2/33** (source line 610): Fixed custom system prompts concatenating the current working directory with later appended prompt content.

</details>

### W5 — Virtual, classifier and image-model APIs

**Upstream:** 0.99.0 adds virtual routing and classifier/image ModelRuntime operations.
**Local evidence:** `packages/ext/session-tracker/index.ts` performs needs-input classification through a chat model; Automode requires richer JSON policy assessments. Footer/usage dashboards consume physical provider/model usage. No virtual model, classifier API or image-generation registration was found.
**Next action:** consider classifier models only after measuring equivalent labels/quality for the tracker. Keep Automode's richer assessment contract. If virtual routing is adopted, explicitly reconcile adapter scope and physical-model usage display; do not add generic routing infrastructure now.

<details>
<summary>7 classified upstream entries</summary>

- **0.99.0/04** (source line 126): **Virtual models** — Extensions can route each request to a different physical model. See Virtual Models.
- **0.99.0/05** (source line 127): **Classifier models** — Run Jev classifiers from codemode scripts, or use any llama.cpp model as a classifier. See How codemode works and Classification.
- **0.99.0/09** (source line 134): Added experimental virtual models: extensions register them with `pi.registerVirtualModel()` and pick a physical model and thinking level for each request. The footer shows the routed model, `/session` lists cost per physical model, and `examples/extensions/jev-router.ts` routes with the Jev classifier. See Virtual Models.
- **0.99.0/13** (source line 138): Added a classifier model for every llama.cpp chat model, answered from next-token label probabilities. See Classification.
- **0.99.0/14** (source line 139): Added inherited Jev classifier models on OpenRouter, Cloudflare Workers AI, Vercel AI Gateway, and OpenCode Zen.
- **0.99.0/17** (source line 142): Added image generation to `ModelRuntime`: `generateImages()` with runtime-resolved auth (stored credentials, OAuth, runtime API keys, `models.json` headers), plus `getModelsOfType()`, `getModelOfType()`, `getAvailableOfType()`, `getAllModels()`, and `getAllAvailable()`. OpenRouter image models are listed under the `openrouter` provider and share its credential; an upstream ID can have separate chat and image entries. `models.json` providers and extension registrations without a model list keep built-in image generation. Extension model lists can include discriminated chat, image, and classifier entries with operation implementations; when supplied, they replace the provider catalog across every operation. Chat-facing reads (`getModels()`, `getAvailableSnapshot()`, the model picker) are unchanged.
- **0.99.0/18** (source line 143): Added classifier support to `ModelRuntime`, including `classify()`, classifier model accessors, runtime-resolved authentication, and the built-in TypeSafe `jev-latest` model.

</details>

### W6 — Extension contracts, registration and lifecycle safety

**Upstream:** 0.84.1–0.99.2 tighten registration validation, event exports/unsubscription, JSON-compatible values, extension loading/cleanup and diagnostic names.
**Local evidence:** `packages/ext/index.ts` composes extension factories; tool/command/flag registrations supply names, schemas and handlers. `subagents/operations.ts` persists custom details, and `code-mode/results.ts` persists nested trace snapshots. `file-search/index.ts` and other deferred paths snapshot dependencies to avoid stale ctx. No local code depends on old `<inline:...>` diagnostic names or omitted hook type exports.
**Next action:** keep details/arguments serializable and treat captured ctx as ephemeral after replacement/reload. Use lifecycle reacquisition or replacement `withSession` for new deferred work. Keep factory failure and throwing-getter tests; use unsubscribe only for dynamically installed handlers. Expected built-in replacement warnings for custom read/bash/edit are not evidence of failure.

<details>
<summary>14 classified upstream entries</summary>

- **0.99.2/23** (source line 96): Fixed extension commands registered without a string name or handler crashing pi when typing `/`; the extension now fails to load with an error instead.
- **0.99.0/08** (source line 133): Added a warning when an extension that registers the same tool, command, or flag replaces a built-in extension.
- **0.99.0/33** (source line 161): Built-in extensions and tools are named `builtin:<name>` (for example `builtin:mcp` and `builtin:read`) in errors, diagnostics, RPC source info, and bug reports, instead of `<inline:name>` and `<builtin:name>`. Their slash commands no longer carry a `[t]` autocomplete tag.
- **0.86.0/06** (source line 294): Changed inherited pi-ai provider stream inputs from `Context` to normalized `TranscriptContext` values. Custom providers must read system prompts and tool declarations from `context.messages` with `getCurrentSystemPrompt()` and `getCurrentTools()`. See Custom Streaming API.
- **0.86.0/07** (source line 295): Restricted inherited `ToolCall.arguments` and `ToolResultMessage.details` to JSON-compatible values, changed `ToolResultMessage` into a conditional type, and made `JsonValue` arrays readonly.
- **0.86.0/16** (source line 307): Added an unsubscribe function from `pi.on()` so extensions can drop event handlers. Handlers added or removed during a dispatch apply to later dispatches, not the current one.
- **0.86.0/17** (source line 308): Exported extension hook event and result types that were previously omitted from the package entry points.
- **0.86.0/58** (source line 355): Fixed extension tools without parameter schemas to be rejected during registration instead of breaking provider requests.
- **0.85.1/05** (source line 383): Fixed SDK import failures caused by unintentionally publishing internal experimental code and dependencies in 0.85.0. The experimental `client` and `experimental/plugin` subpaths and server/client commands are now source-only through `pi-test.sh`; the supported local SDK and stdio RPC API are unchanged.
- **0.84.3/23** (source line 519): Changed the Node.js CLI and RPC entrypoints to load a bundled runtime, reducing startup filesystem reads while keeping the public library and legacy module paths on the modular runtime for normal dependency identity.
- **0.84.3/25** (source line 524): Fixed failed extension factories leaving event subscriptions, provider registrations, and default flag state active.
- **0.84.3/29** (source line 528): Fixed extensions failing to load when the Node.js CLI runs as a single-executable application.
- **0.84.3/53** (source line 552): Fixed `pi.registerFlag()` accepting default values that do not match the declared flag type.
- **0.84.1/13** (source line 649): Fixed extension TUI method wrappers recursing indefinitely when delegating to the original method.

</details>

### W7 — Usage, exports and diagnostics

**Upstream:** 0.84.2–0.99.0 improve usage notices/cost accounting, provider diagnostics, bug reports and visibility of hidden export messages.
**Local evidence:** `packages/ext/usage-dashboard-data.ts` reads raw JSONL assistant usage; `footer/index.ts` displays session usage; `token-count/index.ts` measures prompt/tool/context cost. Hidden messages from `at-mention-context`, `inline-references`, and subagent delivery can contain file/prompt material.
**Next action:** distinguish token/context estimates, raw-history totals and physical-model billing; spot-check new usage paths before changing dashboards. Treat `display: false` as UI visibility, not secrecy: export toggles and optional /bug transcripts can reveal hidden content. Review what is included before sharing a report.

<details>
<summary>20 classified upstream entries</summary>

- **0.99.0/20** (source line 145): Added the `provider_stream_event` extension event for observing parsed provider events before normalization, with an opt-in `/debug-provider` example viewer.
- **0.99.0/21** (source line 146): Added a show/hide toggle (`H`) in HTML exports for custom messages marked `display: false`. Messages remain hidden by default and can also be revealed from the sidebar.
- **0.99.0/25** (source line 150): Added the token usage and cost of codemode `models.classify()` calls to the codemode tool result, so they count toward the session cost; the codemode result shows each call's cost.
- **0.99.0/57** (source line 188): Fixed inherited 1-hour Anthropic cache writes through Vercel AI Gateway being priced at the 5-minute rate.
- **0.99.0/60** (source line 191): Fixed inherited OpenAI Fast mode requests being priced at the standard rate.
- **0.87.0/19** (source line 253): Fixed `/bug` allowing uploads in offline mode while preserving local zip exports.
- **0.87.0/21** (source line 255): Improved crash diagnostics with hints identifying loaded extensions that appear in the stack trace.
- **0.86.1/04** (source line 276): Fixed `/bug` descriptions dropping line breaks from pasted diagnostics.
- **0.86.1/05** (source line 277): Fixed `/bug` hints appearing for user cancellations and retryable provider failures such as service unavailability.
- **0.86.0/02** (source line 287): **Bug reporting** — Report problems with `/bug` using redacted diagnostics, optional transcripts, or exported ZIP archives. See Reporting Bugs.
- **0.86.0/18** (source line 309): Added `/bug [description]` to report a bug to the Pi developers. The report bundles environment, model, provider, extension, and settings metadata (secrets redacted), assistant message diagnostics from the session, optionally the session transcript, or a model-written summary of what went wrong instead. It is uploaded to Radius (no login required; attributed when logged in) or exported as a zip archive, and the report id is recorded in the session as a `pi.bug-report` entry. Crashes are recorded in `~/.pi/agent/crashes.json`, announced once on the next start, and attached to the next report; unexplained errors and exhausted retries point at `/bug` once per session.
- **0.86.0/35** (source line 332): Fixed inherited Amazon Bedrock one-hour cache writes being priced at the five-minute rate.
- **0.86.0/44** (source line 341): Fixed inherited OpenAI-compatible Responses errors to identify the actual provider instead of always labeling them as OpenAI errors.
- **0.86.0/50** (source line 347): Fixed repeated Anthropic thinking-drop notices being shown for the same dropped blocks, and shortened notices while retaining details in the session.
- **0.84.4/07** (source line 449): Added transcript notices for Anthropic thinking blocks dropped during provider recovery when cache miss notices are enabled.
- **0.84.4/11** (source line 453): Added transcript usage notices for compaction and branch summaries when cache miss notices are enabled.
- **0.84.3/08** (source line 501): Added transcript usage notices for compaction and branch summaries when cache miss notices are enabled.
- **0.84.3/24** (source line 520): Changed session sharing to render clickable terminal links, display only the canonical Radius artifact URL, and include the current system prompt and active tool definitions in Radius session shares.
- **0.84.3/43** (source line 542): Fixed inherited Kimi usage reporting so top-level `cached_tokens` count as cache reads instead of normal input tokens.
- **0.84.2/12** (source line 583): Added inherited `AssistantMessage.endTurn` to preserve OpenAI Codex's terminal `end_turn` signal for diagnostics.

</details>

### W8 — Image classification/resizing and local-only viewing

**Upstream:** 0.84.4–0.87.0 export MIME detection, fix EXIF/GIF detection and add per-model resize profiles.
**Local evidence:** `packages/ext/tools.ts` delegates read; `at-mention-context/index.ts` has its own file attachment logic; `codex-adapter/view-image/tool.ts` validates native data-URL output and `README.md` documents local-only image ceilings.
**Next action:** inherit host read/attachment improvements, but preserve native viewer validation/limits and explicit image emission. Use the public MIME helper only if it replaces equivalent local detection without changing accepted types. Resize profiles are user/model settings, not permission to weaken trust boundaries.

<details>
<summary>5 classified upstream entries</summary>

- **0.87.0/03** (source line 228): **Per-model image input limits** — Configure cache-safe image resizing per model for attachments, `read`, and tool-result images. See Image Input Limits.
- **0.87.0/13** (source line 244): Added per-model image resize profiles through `inputLimits.images.resize` in `models.json`, applied to file attachments, image reads, and tool-result images.
- **0.87.0/22** (source line 256): Fixed text files beginning with `GIF` being misclassified as images and omitted from `read` and CLI `@file` input.
- **0.85.0/21** (source line 420): Fixed image orientation detection skipping EXIF data after non-EXIF APP1 segments.
- **0.84.4/09** (source line 451): Added `detectSupportedImageMimeTypeFromFile()` to the public library exports.

</details>

### W9 — Cache warming is independent of local review caching

**Upstream:** 0.86.0–0.87.0 add cost-aware cache warming and fix delayed idle decisions.
**Local evidence:** `packages/ext/automode/history.ts` maintains bounded reviewer evidence; adapter descriptions and whole-prompt overrides also affect prefixes. There is no cache_warming_decision handler or local cache-warmer.
**Next action:** measure session cache costs if enabling idle warming; use the upstream decision event only for an actual policy requirement. Do not assume reviewer-history reuse or leaner native prompts guarantees cache hits.

<details>
<summary>3 classified upstream entries</summary>

- **0.87.0/20** (source line 254): Fixed idle prompt-cache warming rebuilding expired caches when its timer or an extension decision is delayed.
- **0.86.0/01** (source line 286): **Prompt cache warming** — Keep valuable prompt caches alive during long tool runs and optionally while idle using cost-aware refreshes. See Cache Warming.
- **0.86.0/19** (source line 310): Added cost-aware prompt-cache warming during long tool runs and optionally while idle, with configurable modes, model cache-lifetime metadata, `/session` diagnostics, transcript notices, and the `cache_warming_decision` extension event. See Cache Warming.

</details>

### W10 — Strict sampling follows inherited metadata and custom schemas

**Upstream:** 0.84.2 introduces experimental strict sampling; 0.86.0 enables strict-prefer by default.
**Local evidence:** `packages/ext/tools.ts` inherits read/edit constrainedSampling, while replacing edit's parameters. `code-mode/tools.ts` declares a grammar for exec; `code-mode/registration.ts` explicitly turns strict off for wait on legacy Codex wire payloads.
**Next action:** smoke-test actual custom schemas on selected providers. Retain the existing wait compatibility hook until wire behavior is verified; do not remove it merely because docs mention constrainedSampling:false. Keep grammar support and structured fallback route-specific.

<details>
<summary>2 classified upstream entries</summary>

- **0.86.0/26** (source line 320): Enabled strict-prefer JSON-schema sampling by default for built-in `read`, `bash`, `powershell`, `edit`, and `write` tools, without requiring `PI_EXPERIMENTAL`. Extensions can re-register tool definitions with `constrainedSampling: false`.
- **0.84.2/06** (source line 577): Added experimental strict JSON-schema constrained sampling for the default `read`, `bash`, `edit`, and `write` tools under `PI_EXPERIMENTAL=1`.

</details>

## Ignore

### I1 — Host-only implementation changes

No local implementation or invariant depends on these compiler/bundler, startup-performance, managed-download, stock dialog/clipboard, host persistence or internal event-listener fixes. Some are user-facing improvements, but they require no extension action and provide no local code simplification. The collection uses Pi's public SDK/TUI rather than these implementations.

<details>
<summary>31 classified upstream entries</summary>

- **1.0.0/25** (source line 52): Fixed user messages in the transcript keeping two full-width copies of every rendered line; they keep one, with identical output.
- **1.0.0/32** (source line 59): Fixed memory retained per rendered message in the transcript; a long assistant message keeps about a fifth of the heap it kept before.
- **0.99.2/14** (source line 87): Fixed the `/mcp` sign-in URL not being clickable when it wraps across lines, by emitting it as a terminal hyperlink with a `Cmd/Ctrl+click to open` line like `/login`.
- **0.99.2/17** (source line 90): Fixed prompt submission slowing down with session length, because resolving the session's model selection looked up the model catalog once per assistant message.
- **0.99.0/26** (source line 154): Switched the build from the TypeScript native preview to TypeScript 7.0 with an ES2024 target, and replaced `tsx` with Node's built-in type stripping for running from source.
- **0.99.0/27** (source line 155): Removed the `[Themes]` section from the startup banner. Custom themes remain available in `/settings`, and theme conflicts are still reported.
- **0.99.0/28** (source line 156): Changed the startup header to show the pi logo with the version instead of the app name.
- **0.99.0/37** (source line 168): Fixed X11 clipboard text being misidentified as an image when the clipboard owner accepts unadvertised image targets.
- **0.99.0/40** (source line 171): Fixed `RpcClient` skipping the next event listener when a listener unsubscribes while handling an event, which could make `waitForIdle()` time out after `collectEvents()`.
- **0.99.0/50** (source line 181): Reduced CPU use while streaming in long sessions and when previewing themes: the footer caches session usage totals, collapsed bash results cache their preview, and `sanitizeBinaryOutput()` no longer splits output into per-character arrays.
- **0.86.1/03** (source line 272): Enabled Node's persistent compile cache before loading the bundled CLI runtime, reducing repeat launch time.
- **0.86.0/20** (source line 314): Enabled Node's persistent compile cache before loading the bundled CLI runtime, reducing repeat launch time.
- **0.86.0/21** (source line 315): Made `--resume` session results appear progressively, using file modification times to prioritize all-folder loading and cancelling outstanding transcript reads after selection.
- **0.86.0/22** (source line 316): Reduced `--continue` startup time by checking candidate session headers in modification-time order and stopping after the newest matching session.
- **0.86.0/28** (source line 322): Deferred the extension compiler and bundled virtual modules until a filesystem extension is loaded, reducing the baseline SDK import cost.
- **0.86.0/36** (source line 333): Fixed inherited quadratic CPU usage when draining buffered `EventStream` events.
- **0.86.0/49** (source line 346): Fixed exact session ID lookup scanning complete transcript bodies instead of reading session headers.
- **0.85.0/11** (source line 410): Fixed managed `fd` and ripgrep downloads on Linux musl systems.
- **0.85.0/20** (source line 419): Fixed concurrent session shares overwriting one another.
- **0.85.0/31** (source line 430): Fixed managed `fd` and ripgrep downloads requiring the GitHub Releases API.
- **0.84.4/19** (source line 467): Fixed Windows shell aborts crashing Pi when `taskkill.exe` is unavailable on `PATH`.
- **0.84.3/19** (source line 515): Changed Bun release archives to ship the native clipboard binary only inside the wrapper package, removing a duplicate platform package from each archive.
- **0.84.3/20** (source line 516): Changed package resource glob expansion to use Node.js's built-in implementation with deterministic visible-path matching, reducing the installed runtime dependency tree.
- **0.84.3/21** (source line 517): Changed the bundled Node.js runtime to load jiti only when importing an extension and Babel only when uncached source needs transformation, reducing CLI startup time and bundle size.
- **0.84.3/22** (source line 518): Changed syntax highlighting to initialize only twenty common languages eagerly and defer the remaining grammars until after the initial TUI render, reducing CLI startup time.
- **0.84.3/45** (source line 544): Fixed writes to `auth.json` and `models-store.json` overriding administrator-managed file permissions and ACLs.
- **0.84.3/47** (source line 546): Fixed invalid settings files being easy to miss during interactive startup by rendering warnings with the file path inside the TUI.
- **0.84.2/21** (source line 598): Fixed managed-tool downloads delaying TUI startup and hiding diagnostics in fullscreen mode by mounting the TUI first and showing download progress and warnings inside it.
- **0.84.2/26** (source line 603): Updated the transitive `nanoid` development dependency to address a denial-of-service vulnerability.
- **0.84.1/11** (source line 644): Reduced worst-case automatic terminal theme detection delay from 200 ms to 100 ms by probing color-scheme and background support concurrently.
- **0.84.1/12** (source line 648): Fixed Bun standalone binaries crashing on startup when the cwd contains a `bunfig.toml` with `preload` by compiling with `--no-compile-autoload-bunfig`.

</details>

### I2 — Upstream subagent examples, not this implementation

The collection has its own `packages/ext/subagents/` parser, permission broker, runner and model/tool inheritance tests. It does not load the upstream example. YAML tools, trust prompts and inheritance fixes to that example do not migrate local code.

<details>
<summary>3 classified upstream entries</summary>

- **0.84.3/48** (source line 547): Fixed the subagent example repeatedly prompting before running project-local agents in trusted repositories.
- **0.84.2/31** (source line 608): Fixed the subagent example rejecting YAML array syntax for the `tools` frontmatter field.
- **0.84.2/32** (source line 609): Fixed the subagent example dropping parent session model, thinking, and tool configuration.

</details>

### I3 — Unused APIs, flags, labels and integration paths

Search found no GoogleThinkingLevel import, shouldStopAfterTurn option, user_bash handler, Agent.reset call, Cloudflare Workers binding, external client compatibility-subpath import, RPC clear_queue/abort consumer, provider-only CLI invocation, dash-prefixed positional prompt construction, or dependence on renamed provider docs/login labels. Existing README provider links are web URLs, not the renamed bundled section. These entries have no actionable local usage. Header/quiet-startup settings remain host preferences.

<details>
<summary>20 classified upstream entries</summary>

- **1.0.0/07** (source line 25): **Header-only quiet startup** — `quietStartup: "header"` keeps the version and key hints and hides the rest. See Terminal and display.
- **1.0.0/09** (source line 30): Added `quietStartup: "header"`, which keeps the startup header with version and key hints but hides the model scope line and loaded-resource listing.
- **1.0.0/14** (source line 38): The provider docs page is renamed to Providers, its "Cloud Providers" section is now "Provider Specific Config", and it documents Radius first.
- **1.0.0/18** (source line 42): `/login` and `/logout` now label providers without credentials as "not configured" instead of "unconfigured".
- **1.0.0/19** (source line 43): OAuth browser pages now show the color Pi logo.
- **1.0.0/23** (source line 50): Fixed `--provider` without `--model` being silently ignored and running the default model from another provider; it now fails with an error.
- **1.0.0/26** (source line 53): Fixed `/login` and `/logout` labeling every OAuth sign-in, including Radius, as a subscription; only subscription-backed providers say "subscription", other OAuth sign-ins say "account".
- **1.0.0/27** (source line 54): Fixed the startup header logo rendering with gaps in Apple Terminal; it now shows a colored "Pi" with the version instead.
- **0.87.1/08** (source line 218): Fixed missing or invalid `--mode` values being silently ignored instead of reporting an error and exiting with a nonzero status.
- **0.87.0/04** (source line 232): Removed the inherited `shouldStopAfterTurn` agent option. Use `finishTurn` and return `{ action: "end" }` instead. `finishTurn` runs before `turn_end` but applies the decision afterward, and it also receives error and aborted responses; migrate normal-response predicates by returning `undefined` for those hard exits. See the `@earendil-works/pi-agent-core` changelog for a complete before-and-after example.
- **0.86.0/08** (source line 296): `user_bash` now fails closed: errors or invalid defined results abort the command without invoking later handlers or executing locally. Return `undefined` to continue propagation; otherwise return `{ operations }` or `{ result }`.
- **0.85.0/14** (source line 413): Restored the `@earendil-works/pi-coding-agent/client` compatibility entry point.
- **0.85.0/35** (source line 434): Fixed RPC `abort` reporting success without cancelling an in-progress manual compaction.
- **0.84.4/03** (source line 442): **RPC queue clearing** — Retrieve and clear queued steering and follow-up messages with `clear_queue`. See RPC `clear_queue`.
- **0.84.4/12** (source line 454): Added RPC `clear_queue` to retrieve and remove queued steering and follow-up messages.
- **0.84.3/04** (source line 494): Renamed the inherited `GoogleThinkingLevel` type to `GoogleApiThinkingLevel` and added `ResolvedGoogleThinkingLevel` for normalized adapter levels.
- **0.84.3/64** (source line 563): Fixed dash-prefixed prompts being parsed as options by supporting `--` as an end-of-options delimiter.
- **0.84.2/11** (source line 582): Added inherited `createGatewayBindingFetch()` for routing Cloudflare AI Gateway requests through a Workers AI binding without an API token.
- **0.84.2/16** (source line 590): Documented the generic `AI_AGENT=pi` process marker and how it differs from `PI_CODING_AGENT=true`.
- **0.84.1/15** (source line 651): Fixed inherited `Agent.reset()` clearing transcript and runtime state during active runs; it now rejects until the agent is idle.

</details>
