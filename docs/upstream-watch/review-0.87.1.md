# Pi upstream review: 0.84.0 → 0.87.1

Reviewed 2026-09-23. Checkpoint remains **0.84.0**; acceptance has not been requested.

Source: [deterministically fetched published changelog](latest.md), fetched with the bundled helper from the npm package tarball. All **311 bullets across 10 releases** are classified below, including duplicate feature summaries and repeated fixes. Each numbered source reference is a line in that snapshot. Evidence and action under each heading apply to every entry listed beneath it. Ignore means irrelevant to the local implementation, not unimportant upstream.

**Upgrade gate:** the deployed Nix runtime is **0.87.1**, but local `node_modules/@earendil-works/pi-coding-agent/package.json` is **0.85.0**. Align development dependencies before claiming 0.87 compatibility. Do not infer runtime correctness from the older type surface.

Runtime API observations were checked against the installed 0.87.1 bundled source; local TypeScript declarations remain 0.85.0.

**Validation:** `bun check` passed lint and formatting, then stopped with `tsgo: command not found` (exit 127). Typechecking and tests did not run. No source fixes or dependency updates were made as part of this review.

## Adapt

### Boundary event fixtures

**Local evidence:** packages/ext/goal/goal.integration.test.ts and packages/ext/goal/test/continuation.test.ts construct turn_end events; packages/ext/goal/test/support/runtime-harness.ts dispatches synthetic extension events. Its pi.on mock returns no unsubscribe function, unlike the 0.86 contract.

**Next action:** Update fixtures and harness to the 0.87 boundary contract before claiming compatibility; validate actual settled/continuation ordering. The 0.87.1 runtime supplies messageEntryId, toolResultEntryIds, outcome, entries, continue, and boundary context in addition to the old fields; verify their precise types against the updated declarations.

- **0.87.0** (source L52): Expanded `TurnEndEvent` with required boundary fields and added `AgentBeforeSettleEvent` to the exported `ExtensionEvent` union. Consumers constructing events or exhaustively switching on `ExtensionEvent` must handle the new shapes. `ExtensionRunner.emit()` no longer accepts `turn_end`; host integrations dispatch actionable boundaries with `emitBoundary(baseEvent, buildContext)`.

### Tool working-directory propagation

**Local evidence:** packages/ext/tools.ts captures process.cwd() at registration; its bash/edit execute overrides accept and forward only four arguments. Subagents can select another cwd via packages/ext/subagents/spawn-cwd.ts.

**Next action:** Use the execution context cwd consistently for edit planning and execution; forward the execution context to delegated tools. Add a differing-process/session-cwd regression.

- **0.85.0** (source L243): Fixed `bash`, `edit`, `find`, `grep`, `ls`, `read`, and `write` tools ignoring `ctx.cwd`

### JSON-only tool transport types

**Local evidence:** packages/ext/subagents/tool-result.ts, packages/ext/subagents/types.ts and packages/ext/codex-adapter/code-mode/host-protocol.ts carry tool results across typed/serialized boundaries. Local dependencies are still 0.85.0.

**Next action:** Typecheck against 0.87.1; constrain transport values to JSON and handle readonly arrays wherever the new compiler reports incompatibilities. This is an upgrade gate, not a confirmed runtime serialization failure.

- **0.86.0** (source L112): Restricted inherited `ToolCall.arguments` and `ToolResultMessage.details` to JSON-compatible values, changed `ToolResultMessage` into a conditional type, and made `JsonValue` arrays readonly.

### Context inspector must use canonical projection

**Local evidence:** packages/ext/context.ts:235-240 flattens buildContextEntries() with sessionEntryToContextMessages. That per-entry mapping cannot apply context_edit omissions/replacements across entries; the inspector estimates prompt/tools separately.

**Next action:** Use `sessionManager.buildSessionProjection().messages` for the Messages estimate and exclude separately counted system/tool declarations. Add one omission/replacement regression; raw-history usage totals should remain raw.

- **0.87.0** (source L50): Added `ContextEditEntry` to the exported `SessionEntry` union. TypeScript consumers with exhaustive entry switches must handle `context_edit`; use `replacement: null` for omission and a content replacement otherwise.
- **0.87.0** (source L51): Made `SessionManager` canonical for `AgentSession` provider context. Assigning `session.agent.state.messages` no longer replaces future request history; restore with `SessionManager.inMemory(cwd, { id }, entries)`, navigate with `session.navigateTree()`, or append through `session.sessionManager` and call `session.refreshContext()`.
- **0.87.0** (source L67): Fixed edited-context accounting both discarding valid assistant usage captured after the latest context edit and reusing that usage after a later compaction made it stale.

## Leverage

### Registry-backed auxiliary model calls

**Local evidence:** packages/ext/automode/index.ts resolves auth, headers, env and baseUrl manually; packages/ext/session-tracker/index.ts resolves auth manually for classification.

**Next action:** Consider snapshotting modelRegistry and using its streamSimple API plus result() to centralize configured-provider/auth handling; preserve timeouts, reasoning, and cancellation.

- **0.86.0** (source L121): Added `ctx.modelRegistry.stream()` and `streamSimple()` for extension model calls through configured providers with resolved authentication

### Native compaction and failure handling

**Local evidence:** packages/ext/auto-compaction.ts implements an absolute 150,000-token policy and private \_runAutoCompaction hook; packages/ext/goal/goal-runtime-events.ts already subscribes to session_compact_failed.

**Next action:** Compare native per-model budgets and between-tool compaction against the absolute-threshold requirement; remove custom abort/resume/private hooks only if equivalent. Retain cancellation regressions and existing failure handlers.

- **0.87.1** (source L34): Fixed split-turn compaction summaries being refused by Claude Fable 5.1 by clearly separating the conversation and using continuation-oriented instructions
- **0.87.0** (source L58): Added actionable `turn_end` and `agent_before_settle` extension boundaries. Return `{ entries: [...event.entries, draft], continue: true }` to persist structural entries in order and ensure one next provider request without changing steering or follow-up scheduling.
- **0.86.1** (source L96): Fixed inherited z.ai `Prompt too long` errors not being recognized as context overflow
- **0.86.0** (source L107): **Per-model compaction budgets** — Configure reserved and recent-token budgets by model.
- **0.86.0** (source L122): Added per-model `reserveTokens` and `keepRecentTokens` settings through `compaction.modelOverrides`, with ordinary compaction settings as fallback
- **0.86.0** (source L145): Fixed inherited bodyless HTTP 400/413 errors from non-Cerebras providers being misclassified as context overflow
- **0.86.0** (source L160): Fixed inherited retry classification for Cloudflare 520 responses
- **0.86.0** (source L161): Fixed inherited retry classification for transient Azure peak-load capacity errors
- **0.86.0** (source L162): Fixed session tree navigation racing with active compaction and replacing its progress UI
- **0.86.0** (source L165): Fixed mid-run threshold compaction silently skipping oversized trailing tool results
- **0.86.0** (source L168): Capped agent-level retry backoff at `retry.maxAgentDelayMs` (60s by default) so long retry runs stay responsive during prolonged transient outages
- **0.86.0** (source L175): Fixed cancellation races that could start automatic compaction, leave stale retry state, or miss cancellation while waiting for summarization authentication
- **0.85.0** (source L248): Fixed branch summaries failing when reasoning consumes the previous 2048-token output cap
- **0.85.0** (source L251): Fixed RPC `abort` reporting success without cancelling an in-progress manual compaction
- **0.84.4** (source L270): Added transcript usage notices for compaction and branch summaries when cache miss notices are enabled.
- **0.84.4** (source L287): Fixed compaction and branch summaries forcing `toolChoice: "none"`
- **0.84.4** (source L288): Fixed large tool results crossing the auto-compaction threshold being sent to the provider before compaction. Pi now compacts between tool execution and the next assistant response in the same run, and restores interactive progress when that run resumes
- **0.84.3** (source L317): Added optional routing session IDs to exported compaction summary helpers so callers can preserve provider routing without enabling prompt cache writes.
- **0.84.3** (source L318): Added transcript usage notices for compaction and branch summaries when cache miss notices are enabled.
- **0.84.3** (source L319): Added `session_compact_failed` extension events so compaction failures and aborts expose their reason, retry state, source, and error message to handlers
- **0.84.3** (source L347): Fixed compaction and branch summarization requests exposing tools to providers.
- **0.84.3** (source L365): Added `session_compact_failed` extension events so compaction failures and aborts expose their reason, retry state, source, and error message to handlers
- **0.84.3** (source L366): Fixed truncated compaction and branch summaries being persisted when generation reaches its output token limit
- **0.84.3** (source L371): Fixed repeated ambiguous truncated-response recovery being mislabeled as context overflow
- **0.84.3** (source L379): Fixed threshold auto-compaction being skipped when providers omit streaming usage data

### Non-steering metadata messages

**Local evidence:** packages/ext/at-mention-context/index.ts and packages/ext/subagents/subagent-messages.ts use triggerTurn:false.

**Next action:** Rely on corrected upstream scheduling; verify metadata survives a running tool batch without steering or splitting call/result pairs.

- **0.84.4** (source L286): Fixed extension messages sent with `triggerTurn: false` while the agent is running being inserted between a tool call and its result, which made providers that validate message order reject the replayed history. They are now appended once the turn's tool results are in
- **0.84.2** (source L423): Fixed `pi.sendMessage(..., { triggerTurn: false })` steering an active run instead of only recording the custom message

### Terminating approval denials

**Local evidence:** packages/ext/bash-gate/authorization.ts already carries terminate?:boolean through blocked results.

**Next action:** Preserve this support; test all-terminating versus mixed batches before changing denial policy.

- **0.84.1** (source L448): **Terminating blocked tool calls** — Extension `tool_call` handlers can stop all-terminating batches without another model call.
- **0.84.1** (source L454): Added `terminate` support to blocked extension `tool_call` events so all-terminating batches can skip the automatic follow-up model call.

## Watch

### Canonical context and normalized provider inputs

**Local evidence:** packages/ext/subagents/agent-runner.ts restores/forks SDK sessions; packages/ext/auto-compaction.ts reads agent.state.messages after private compaction. packages/ext/automode/index.ts and packages/ext/session-tracker/index.ts deliberately import completeSimple from pi-ai/compat. agent-runner.ts:419-446 already seeds SessionManager.inMemory before createAgentSession instead of assigning state.messages.

**Next action:** Keep history changes in SessionManager; audit compaction snapshots and context filters under 0.87.1. Do not mechanically convert compat calls to the normalized API. Keep automode authorization provenance based on validated raw history; canonical context omission must not erase human-approval evidence.

- **0.87.0** (source L43): **Canonical session context and extension boundaries** — Edit model context without rewriting history and add actionable lifecycle hooks.
- **0.87.0** (source L57): Added append-only model-context edits. For example, `sessionManager.appendContextEdit(entryId, null)` omits one message from future provider context without changing raw history, usage, or UI history.
- **0.87.0** (source L59): Added retain-none compaction input: `sessionManager.appendCompaction(summary, null, tokensBefore)` stores the compaction's own ID as its kept boundary.
- **0.87.0** (source L65): Fixed string context-edit replacements producing invalid assistant and tool-result message content instead of text blocks.
- **0.87.0** (source L66): Fixed context-invisible boundary metadata and replacement edits causing newly appended or replaced input to be summarized before its first provider request.
- **0.86.0** (source L111): Changed inherited pi-ai provider stream inputs from `Context` to normalized `TranscriptContext` values. Custom providers must read system prompts and tool declarations from `context.messages` with `getCurrentSystemPrompt()` and `getCurrentTools()`.
- **0.85.0** (source L214): Added `SessionManager.inMemory()` support for restoring externally managed session entries

### Settled notification ordering

**Local evidence:** packages/ext/goal/continuation-scheduler.ts, packages/ext/auto-compaction.ts and packages/ext/session-tracker/index.ts depend on agent_settled.

**Next action:** Exercise continuation, cancellation, and session replacement on 0.87.1; preserve the rule that deferred work must not dereference captured ctx.

- **0.87.0** (source L53): Deferred runs requested from `agent_settled` handlers until all settled handlers finish. Handlers still observe `ctx.isIdle() === true`, but no longer see a reentrant `agent_start` during the same notification dispatch.

### Prompt, context and active-tool replay

**Local evidence:** packages/ext/ponytail/index.ts and packages/ext/codex-adapter/code-mode/registration.ts modify before_agent_start systemPrompt; packages/ext/goal/goal-runtime-input-context-handlers.ts filters context.

**Next action:** Smoke-test resume, tree navigation, compaction, and model switching with both prompt extensions enabled; move to context_with_system only if full-transcript system transformation is actually needed. The existing goal filter rewrites conversation messages only and is compatible with ordinary context; no migration is indicated for it.

- **0.87.0** (source L44): **Full-transcript context extensions** — Use `context_with_system` for per-request system-message transformations.
- **0.87.0** (source L60): Added the `context_with_system` extension event, which runs after `context` handlers on the full transcript including system messages and sends its result verbatim.
- **0.87.0** (source L69): Fixed `context` handlers that filter or slice messages dropping the prompt and tool declarations, which after extension-driven compaction left requests without built-in tools or made Codex emit raw tool-call text. Handlers no longer see system messages; Pi restores the prompt and tool state after they run.
- **0.86.0** (source L105): **Transcript-aware prompt and tool updates** — Preserve instruction and tool changes across resume and branch navigation while retaining cached prefixes.
- **0.86.0** (source L117): Added transcript-backed mid-conversation system prompt and tool changes so instruction and tool updates survive resume and branch navigation while preserving cached prefixes on supported models.
- **0.86.0** (source L173): Fixed `before_agent_start` handlers returning `systemPrompt` (and `forceSystemPrompt`) on models with mid-conversation system messages: the forced prompt is now sent as the provider's leading system prompt instead of being appended as a section patch after the original prompt.
- **0.84.2** (source L427): Fixed custom system prompts concatenating the current working directory with later appended prompt content

### Strict schemas and deferred/native tools

**Local evidence:** packages/ext/tools.ts replaces edit parameters while inheriting a built-in definition; packages/ext/codex-adapter/code-mode/tools.ts defines constrained sampling; code-mode/registration.ts sets wait.strict=false at the wire hook.

**Next action:** Inspect 0.87.1 emitted schemas for read/bash/edit/exec/wait. Keep the wait workaround until a provider-wire regression proves the public opt-out works; all registered tools must retain schemas. The inherited edit constrainedSampling value is generic json_schema/strict:prefer, not an edits[]-specific schema; the runtime applies it to the replacement schema and normalizes nullable optional inputs before validation, so no edit-schema incompatibility was demonstrated.

- **0.87.0** (source L75): Fixed inherited unknown OpenAI-compatible Chat Completions endpoints receiving strict tool schemas unless they explicitly advertise support
- **0.86.1** (source L97): Fixed inherited Cerebras models advertising unsupported strict tool schemas, which caused HTTP 400 errors when strict and non-strict tools were mixed
- **0.86.0** (source L118): Added inherited native deferred tool loading for Fireworks Messages models. Use `ToolSearch` or `tool_search` as the loader name for prompt-prefix deferral
- **0.86.0** (source L137): Enabled strict-prefer JSON-schema sampling by default for built-in `read`, `bash`, `powershell`, `edit`, and `write` tools, without requiring `PI_EXPERIMENTAL`. Extensions can re-register tool definitions with `constrainedSampling: false`.
- **0.86.0** (source L172): Fixed extension tools without parameter schemas to be rejected during registration instead of breaking provider requests
- **0.84.2** (source L394): Added experimental strict JSON-schema constrained sampling for the default `read`, `bash`, `edit`, and `write` tools under `PI_EXPERIMENTAL=1`.
- **0.84.2** (source L400): Added inherited `AssistantMessage.endTurn` to preserve OpenAI Codex's terminal `end_turn` signal for diagnostics
- **0.84.2** (source L408): Changed inherited OpenAI Responses deferred tool loading to prefer message-anchored `additional_tools` where supported while retaining tool-search and top-level fallbacks
- **0.84.2** (source L428): Fixed inherited OpenAI Responses function and custom tool calls losing namespaces during streaming, proxying, and replay

### Clipboard backend changes

**Local evidence:** packages/ext/goal/clipboard.ts runs its own platform commands; upstream clipboard fixes do not automatically fix this helper.

**Next action:** Test goal-copy separately on WSL/headless hosts; evaluate a public upstream clipboard API before replacing the helper. Do not report OSC 52 success without confirmation.

- **0.86.1** (source L95): Fixed clipboard copy failing in containers and WSL without WSLg by restoring the OSC 52 fallback when no display is available, and added a verified Windows clipboard backend for WSL
- **0.86.0** (source L134): Replaced the external native clipboard dependency with bundled asynchronous macOS, Windows, and X11 helpers while preserving platform command and OSC 52 fallbacks
- **0.86.0** (source L167): Fixed local clipboard failures reporting success when the terminal ignored the fallback OSC 52 write, and added platform-specific setup guidance when no clipboard backend works
- **0.84.4** (source L260): **Fullscreen selection copy controls** — Disable automatic selection copying in fullscreen mode and use Ctrl+X to copy the active selection.
- **0.84.4** (source L273): Added `fullscreenCopyOnSelect` to disable automatic fullscreen selection copy; when disabled, `Ctrl+X` copies the active text selection before falling back to the last assistant message, while `/tree` still copies the selected message
- **0.84.2** (source L439): Fixed fullscreen selection copy to use the host clipboard and report failure instead of claiming success when OSC 52 is unsupported
- **0.84.1** (source L467): Fixed right-click not pasting clipboard text in fullscreen mode on Windows.

### Skills, configuration and autocomplete discovery

**Local evidence:** packages/ext/inline-references/index.ts reads skill Markdown and uses fuzzyFilter; packages/ext/file-search/index.ts uses fff; packages/ext/config.ts and packages/ext/subagents/settings.ts parse local configuration.

**Next action:** Check nested skills, BOM/frontmatter warnings and punctuation paths in the local custom paths; upstream parser fixes are not necessarily inherited. Keep custom file-search ranking unless its requirements match upstream.

- **0.87.0** (source L74): Fixed malformed prompt template frontmatter being silently ignored instead of reported as a resource warning
- **0.86.0** (source L135): Reduced inherited fuzzy search latency for long texts by using native substring search instead of scanning each character in JavaScript
- **0.86.0** (source L177): Fixed inherited skill slash-command autocomplete ranking the `skill:` prefix instead of the bare skill name
- **0.86.0** (source L178): Fixed inherited file autocomplete boundaries and path quoting around CJK punctuation
- **0.85.1** (source L201): Fixed mouse hover changing selection and recentering autocomplete and settings lists, causing clicks to target a different item.
- **0.85.0** (source L235): Fixed skills being unavailable when Bash is the only enabled tool
- **0.84.4** (source L291): Fixed inherited `@` file autocomplete ranking to prefer direct and shallower matches over similarly ranked nested paths
- **0.84.3** (source L333): Changed package resource glob expansion to use Node.js's built-in implementation with deterministic visible-path matching, reducing the installed runtime dependency tree.
- **0.84.3** (source L346): Fixed nested Markdown skills inside `.agents/skills/` grouping directories not being discovered.
- **0.84.3** (source L349): Fixed root Markdown files such as `README.md` and `AGENTS.md` in skill directories being reported as broken skills unless they declare valid skill frontmatter
- **0.84.3** (source L362): Fixed UTF-8 BOM markers preventing frontmatter and user configuration files from loading
- **0.84.3** (source L363): Fixed invalid settings files being easy to miss during interactive startup by rendering warnings with the file path inside the TUI
- **0.84.2** (source L398): Added `expandPromptTemplates` to extension `pi.sendUserMessage()` options for explicitly dispatching commands and expanding skills and prompt templates.
- **0.84.2** (source L413): Fixed root Markdown files such as `README.md` and `AGENTS.md` in skill directories being reported as broken skills unless they declare valid skill frontmatter

### Built-in tool and shell behavior

**Local evidence:** packages/ext/tools.ts delegates read/bash/edit execution/rendering; packages/ext/codex-adapter/code-mode/delegates.ts wraps tool identity; packages/ext/bash-gate/index.ts gates execution.

**Next action:** Smoke-test aborts, large outputs, binary/image detection and inherited duration/rendering behavior. The custom edit API remains old_string/new_string; upstream single-object edit normalization does not replace it. Do not enable optional PowerShell until authorization covers it: bash-gate/authorization.ts currently recognizes only bash and exec_command.

- **0.87.0** (source L45): **Per-model image input limits** — Configure cache-safe image resizing per model for attachments, `read`, and tool-result images.
- **0.87.0** (source L61): Added per-model image resize profiles through `inputLimits.images.resize` in `models.json`, applied to file attachments, image reads, and tool-result images
- **0.87.0** (source L73): Fixed text files beginning with `GIF` being misclassified as images and omitted from `read` and CLI `@file` input
- **0.86.0** (source L138): Formatted Bash and PowerShell tool durations of at least one minute as minutes and seconds, with hours when needed
- **0.86.0** (source L166): Fixed signal-terminated local shell commands being reported as successful with partial output
- **0.85.0** (source L227): Fixed managed `fd` and ripgrep downloads on Linux musl systems
- **0.85.0** (source L237): Fixed image orientation detection skipping EXIF data after non-EXIF APP1 segments
- **0.85.0** (source L247): Fixed managed `fd` and ripgrep downloads requiring the GitHub Releases API
- **0.85.0** (source L249): Fixed the write tool reporting UTF-16 code-unit counts as byte counts by removing the misleading count
- **0.84.4** (source L268): Added `detectSupportedImageMimeTypeFromFile()` to the public library exports
- **0.84.4** (source L283): Fixed toggling thinking visibility clearing partial output from running Bash tools
- **0.84.4** (source L284): Fixed Windows shell aborts crashing Pi when `taskkill.exe` is unavailable on `PATH`
- **0.84.3** (source L305): **PowerShell tool** — Use optional native PowerShell command execution on Windows.
- **0.84.3** (source L315): Added an optional `powershell` tool for Windows, configurable through `defaultTools` and the SDK.
- **0.84.3** (source L348): Fixed single-object `edit` tool inputs failing validation by accepting them as one-edit arrays in both coding-agent and harness edit tools
- **0.84.2** (source L387): **Configurable default tools** — Choose startup built-in tools globally or per project.
- **0.84.2** (source L396): Added the `defaultTools` setting for configuring the initial built-in tool selection globally or per project.
- **0.84.2** (source L414): Fixed single-object `edit` tool inputs failing validation by accepting them as one-edit arrays in both coding-agent and harness edit tools
- **0.84.2** (source L421): Fixed fallback rendering for extension tool results to collapse long output and honor tool expansion
- **0.84.2** (source L424): Fixed the `defaultTools` setting dropping extension and SDK custom tools when selecting built-in defaults.
- **0.84.1** (source L460): Softened the bash tool's `PI_*` environment guideline in an attempt to reduce unnecessary inspection commands

### Terminal/TUI interaction and presentation

**Local evidence:** packages/ext/footer/index.ts supplies a custom footer; packages/ext/subagents/ui/conversation-viewer.ts and packages/ext/view/index.ts render custom UI; packages/ext/tools.ts delegates built-in renderers.

**Next action:** Perform a narrow-terminal/fullscreen/overlay smoke check. No custom editor is registered, so spinner embedding is inherited rather than a required editor migration; no local patch for upstream-only visual fixes.

- **0.86.0** (source L119): Added click toggling for branch summaries, compaction summaries, and skill invocation entries.
- **0.86.0** (source L136): Moved compaction, branch summarization, and retry spinners into the editor border alongside the working indicator. Custom editors use the same embedding opt-in for all status spinners.
- **0.86.0** (source L171): Fixed fullscreen mode reserving a blank row for custom footers that render zero rows
- **0.86.0** (source L176): Fixed asynchronous Kitty image conversion replacing newer partial tool output images
- **0.86.0** (source L179): Fixed inherited LaTeX legacy font switches falling back to raw source, centered `cases` layouts around surrounding equations, and vertically laid out unsupported and nested display scripts
- **0.86.0** (source L180): Fixed inherited fullscreen Kitty images being erased by later row clears in WezTerm
- **0.85.1** (source L195): Added five-times-faster mouse wheel scrolling while holding Alt in fullscreen mode
- **0.85.1** (source L199): Fixed configurable save keybindings in the model and thinking selectors
- **0.85.0** (source L209): **Fullscreen transcript controls** — Jump to the latest message from a scrolled transcript and use the embedded working indicator.
- **0.85.0** (source L216): Added inherited LaTeX rendering for relational algebra join symbols
- **0.85.0** (source L217): Added a clickable "Jump to latest message" label with the `tui.altScreen.bottom` shortcut to the fullscreen transcript while it is scrolled up
- **0.85.0** (source L222): Moved the streaming working indicator into the default editor border and matched its default spinner and label to the thinking-level border color. Custom editors retain the standalone indicator unless they opt in to embedding it
- **0.85.0** (source L223): Reduced inherited fullscreen transcript search latency on large transcripts by caching unchanged search results, indexing ASCII runs, and limiting highlight work to visible matches
- **0.85.0** (source L232): Fixed inherited OpenAI Codex SSE parsing to process terminal events that are not followed by a blank line
- **0.85.0** (source L244): Fixed inherited terminal startup under restricted seccomp policies that reject the `SIGWINCH` self-signal
- **0.85.0** (source L245): Fixed inherited Zed terminal image capability detection
- **0.85.0** (source L246): Fixed drag selection continuing over the fullscreen editor.
- **0.84.4** (source L257): **Terminal capability overrides** — Override detected terminal hyperlink, image, and truecolor support.
- **0.84.4** (source L272): Added environment variables and advanced settings for overriding auto-detected terminal hyperlink, image, and truecolor capabilities
- **0.84.4** (source L277): Changed fullscreen scrollbars to reveal on pointer entry, support optional `scrollbarTrack` and `scrollbarThumb` theme colors with muted and text fallbacks, keep one thumb color across normal and expanded states, and support track-click jumping.
- **0.84.4** (source L278): Changed fullscreen transcript search arrows to underline on hover and capitalized the search placeholder.
- **0.84.4** (source L279): Changed selectors in `/thinking`, `/model`, `/scoped-models`, `/trust`, per-model thinking settings, and theme settings to keep active options marked while browsing. `/scoped-models` now uses consistent per-item toggles and strikes through unavailable models
- **0.84.4** (source L294): Fixed inherited fullscreen double-click word selection splitting paths and kebab-case tokens on `/` and `-`
- **0.84.3** (source L307): **Model and thinking controls** — Select thinking levels with `/thinking`, search defaults, keep selections session-scoped, and persist them explicitly with Ctrl+S.
- **0.84.3** (source L316): Added a `/thinking` selector and searchable default choices to the model and thinking selectors; Ctrl+S saves the selected model as the global default.
- **0.84.3** (source L331): Changed Windows and WSL keybinding defaults to avoid terminal-reserved shortcuts for image paste, model cycling, editor undo, fullscreen transcript navigation and search, and message queueing
- **0.84.3** (source L335): Changed syntax highlighting to initialize only twenty common languages eagerly and defer the remaining grammars until after the initial TUI render, reducing CLI startup time.
- **0.84.3** (source L372): Fixed duplicate fullscreen right-click paste in VS Code-based terminals on Windows
- **0.84.3** (source L373): Fixed inherited padded text exceeding narrow terminal widths
- **0.84.3** (source L374): Fixed inherited wrapped Markdown table links leaking color into borders and neighboring cells, including tables inside blockquotes
- **0.84.2** (source L386): **Fullscreen transcript search** — Search and navigate matches in fullscreen mode.
- **0.84.2** (source L388): **Configurable fullscreen exit output** — Print the transcript or only a resume hint on exit.
- **0.84.2** (source L392): Added per-block fullscreen mouse expansion for thinking sections and tool results, while preserving drag selection and link activation.
- **0.84.2** (source L393): Added fullscreen transcript search with `Ctrl+Shift+F`, incremental match highlighting, configurable search match theme colors, and next/previous navigation with `Enter`/`Ctrl+G` and `Shift+Enter`/`Ctrl+Shift+G`.
- **0.84.2** (source L395): Added a fullscreen exit output setting to choose between printing the final transcript and only a session resume hint.
- **0.84.2** (source L397): Added `--use-theme <name[/name]>` to choose an initial per-run interactive theme without changing saved settings
- **0.84.2** (source L401): Added inherited unbound single-line transcript scrolling actions for fullscreen mode.
- **0.84.2** (source L409): Reduced inherited fullscreen rendering allocation churn by painting full-width layout rows directly instead of recompositing them on every frame.
- **0.84.2** (source L415): Fixed managed-tool downloads delaying TUI startup and hiding diagnostics in fullscreen mode by mounting the TUI first and showing download progress and warnings inside it.
- **0.84.2** (source L418): Fixed fullscreen transcript search snapping back to the current match during manual scrolling and fragmented mouse input leaking into the search query.
- **0.84.2** (source L419): Fixed inherited required LaTeX arguments starting on a new line being parsed as empty
- **0.84.2** (source L434): Fixed inherited fullscreen mouse drag selection and OSC 8 link activation in terminals that report generic SGR mouse release button codes
- **0.84.2** (source L435): Fixed inherited focused fullscreen overlays not receiving mouse wheel or viewport scroll keys such as PageUp and PageDown
- **0.84.2** (source L436): Fixed inherited LaTeX control spaces split across line endings causing complete expressions to fall back to raw source.
- **0.84.2** (source L437): Fixed split `Alt+Enter` input over SSH being misread as Escape, added `PI_TUI_ESC_TIMEOUT` for high-latency terminals, and limited that timeout to lone Escape input
- **0.84.2** (source L438): Fixed inherited idle fullscreen sessions repainting and clearing text selection when the terminal loses focus
- **0.84.1** (source L447): **Improved fullscreen interaction** — Select words and paragraphs with multiple clicks and configure half-page transcript scrolling.
- **0.84.1** (source L455): Added inherited double-click word and whitespace selection, granularity-aware drag selection, and triple-click paragraph selection in fullscreen mode
- **0.84.1** (source L456): Added inherited unbound half-page transcript scrolling actions for fullscreen mode.
- **0.84.1** (source L461): Reduced worst-case automatic terminal theme detection delay from 200 ms to 100 ms by probing color-scheme and background support concurrently.
- **0.84.1** (source L466): Fixed extension TUI method wrappers recursing indefinitely when delegating to the original method
- **0.84.1** (source L469): Fixed inherited LaTeX relation, multiplication, and named-operator spacing, and matrix composition with stacked fractions, operator limits, and adjacent matrices.
- **0.84.1** (source L470): Reduced inherited fullscreen mouse event volume under tmux, Zellij, and GNU Screen by using button-motion tracking instead of all-motion tracking.

### Provider catalogs, protocols, reasoning and accounting

**Local evidence:** packages/ext/subagents/model-resolver.ts resolves configured model names; packages/ext/small-model.ts selects auxiliary models; packages/ext/footer/index.ts and packages/ext/usage-dashboard.ts consume upstream usage.

**Next action:** Inherit upstream fixes; check configured model aliases and costs when switching providers. No local GPT-5.4 selection pin was found. Do not reimplement provider adapters or pin new models without a user requirement.

- **0.87.1** (source L19): **Latest frontier models** — Use Claude Opus 5.5, GPT-6 Sol, and GPT-6 Luna through supported providers, including GitHub Copilot.
- **0.87.1** (source L20): **Grok 4.7 by default for xAI** — New xAI sessions now default to Grok 4.7.
- **0.87.1** (source L24): Added inherited Claude Opus 5.5, GPT-6 Sol, and GPT-6 Luna support for GitHub Copilot.
- **0.87.1** (source L25): Added inherited GPT-6 Sol and GPT-6 Luna support for OpenAI API keys and OpenAI Codex subscriptions.
- **0.87.1** (source L26): Added inherited Claude Opus 5.5 support for Anthropic with adaptive thinking and a 1M context window.
- **0.87.1** (source L30): Changed the default xAI model to Grok 4.7.
- **0.87.1** (source L36): Fixed inherited image-only user messages being rejected by some OpenAI-compatible providers because they included an empty text part
- **0.87.1** (source L37): Fixed inherited Anthropic OAuth requests reporting an outdated Claude Code version.
- **0.87.0** (source L68): Fixed selected error retries and final length/overflow recovery retaining abandoned model attempts in future provider context; post-run recovery omissions are now persisted without hiding raw transcript history or changing queue scheduling.
- **0.86.1** (source L81): **Meta Muse provider** — Sign in with Meta using `/login meta` or use `META_API_KEY` to access Muse Spark models.
- **0.86.1** (source L85): Added Meta (Muse subscription) login via `/login meta` with automatic Model API key refresh, plus `META_API_KEY` support
- **0.86.0** (source L106): **Offline Radius model catalog** — Select Radius models immediately, with cached and live catalogs overlaid when available.
- **0.86.0** (source L120): Added the public Radius model catalog for immediate and offline model selection, with cached and live gateway catalogs overlaid when available.
- **0.86.0** (source L123): Added `compat.allowedFallbackModels` configuration for overriding or disabling Anthropic server-side fallback models
- **0.86.0** (source L143): Fixed GitHub Copilot GPT models, including GPT-6 Astra, using the Chat Completions adapter instead of the required Responses adapter
- **0.86.0** (source L144): Fixed inherited DeepSeek V4.1 thinking levels on OpenRouter and OpenCode Go preserving provider effort metadata
- **0.86.0** (source L146): Fixed inherited Vercel AI Gateway replaying unsigned thinking as assistant text
- **0.86.0** (source L147): Fixed inherited Google Generative AI and Vertex AI using unsupported thinking levels when reasoning is omitted or when model capabilities differ within a Gemini family
- **0.86.0** (source L148): Fixed inherited Anthropic-compatible relays breaking signed thinking replay when they report a different response model, while preserving fallback pricing
- **0.86.0** (source L149): Fixed inherited Amazon Bedrock one-hour cache writes being priced at the five-minute rate
- **0.86.0** (source L150): Fixed inherited quadratic CPU usage when draining buffered `EventStream` events
- **0.86.0** (source L151): Fixed inherited Mistral Medium reasoning requests to use `reasoning_effort` for all reasoning-capable `mistral-medium-*` model IDs instead of the unsupported `prompt_mode`
- **0.86.0** (source L152): Fixed inherited OpenCode and OpenCode Go requests to send `x-opencode-session` from `sessionId` across all supported API adapters
- **0.86.0** (source L153): Fixed inherited OpenAI Codex requests to send the model's Off reasoning effort instead of omitting it, while respecting unsupported Off mappings
- **0.86.0** (source L154): Fixed inherited Fireworks unsigned thinking replay and reasoning effort selection using catalog metadata, with verified DeepSeek V4 and Qwen3.8 fallbacks and removal of redundant GLM 5.2 and Kimi K3 effort aliases
- **0.86.0** (source L155): Fixed inherited OpenRouter requests to send `x-session-id` from `sessionId` for Chat Completions and Anthropic Messages models when prompt caching is enabled
- **0.86.0** (source L156): Fixed the inherited DeepSeek catalog to advertise `deepseek-flash` for DeepSeek V4.1 Flash instead of retired Flash aliases, and refreshed DeepSeek pricing metadata
- **0.86.0** (source L157): Fixed inherited Mistral-hosted GLM-5.2 reasoning requests to use `reasoning_effort` instead of the ignored `prompt_mode`
- **0.86.0** (source L158): Fixed inherited OpenAI-compatible Responses errors to identify the actual provider instead of always labeling them as OpenAI errors
- **0.86.0** (source L159): Fixed inherited Baseten requests to send session-affinity headers from `sessionId` for automatic prompt-cache routing
- **0.86.0** (source L164): Fixed repeated Anthropic thinking-drop notices being shown for the same dropped blocks, and shortened notices while retaining details in the session
- **0.86.0** (source L170): Fixed premature missing-model errors after login by waiting for catalog discovery. Radius now defaults to `balanced`, falling back to the first available Radius model when needed.
- **0.86.0** (source L174): Fixed loaded llama.cpp models with `enable_thinking` chat templates ignoring Pi's thinking level
- **0.86.0** (source L184): Removed unavailable inherited GPT-5.4 and GPT-5.4 mini models from OpenAI Codex selection
- **0.85.1** (source L190): **GPT-6 Astra** — Available through OpenAI API keys and OpenAI Codex subscriptions.
- **0.85.1** (source L194): Added GPT-6 Astra for OpenAI API keys and OpenAI Codex subscriptions.
- **0.85.1** (source L202): Fixed long prompt-cache requests for GPT-5.6+ Responses models to use `prompt_cache_options.ttl: "30m"` instead of `prompt_cache_retention: "24h"`.
- **0.85.0** (source L208): **Persistent Claude thinking effort** — Supported Anthropic transports preserve per-turn effort and recover safely from signed-thinking mismatches.
- **0.85.0** (source L215): Added inherited OpenAI-compatible `vllmPriority` and `supportsMaxOutputTokens` model settings for vLLM scheduler priority and OpenAI Responses output-token limits
- **0.85.0** (source L218): Added Meta (Muse subscription) login via `/login meta` with automatic Model API key refresh, plus `META_API_KEY` support.
- **0.85.0** (source L228): Removed the unavailable inherited Grok Build 0.1 model from `/model`
- **0.85.0** (source L229): Fixed inherited provider streams emitting incompatible event sequences and custom tool-call deltas.
- **0.85.0** (source L231): Fixed the inherited Qwen Token Plan Individual catalog to include Qwen3.8 Flash
- **0.85.0** (source L233): Fixed inherited GitHub Copilot Claude Fable 5 requests so selected reasoning levels are sent
- **0.85.0** (source L234): Fixed inherited Baseten GLM-5.2 models incorrectly advertising image input support
- **0.85.0** (source L241): Fixed inherited Fireworks GLM models using the wrong API adapter.
- **0.85.0** (source L242): Fixed inherited `NO_PROXY` matching for root domains and subdomains
- **0.85.0** (source L250): Fixed proxied plain-HTTP provider requests hanging after a tool call by tunneling them with CONNECT
- **0.84.4** (source L261): **DeepSeek V4 Flash Vision (experimental)** — Use the vision-capable model through the built-in DeepSeek provider.
- **0.84.4** (source L265): Added `supportsMidConvoEffort` to custom Anthropic Messages model compatibility settings.
- **0.84.4** (source L266): Added transcript notices for Anthropic thinking blocks dropped during provider recovery when cache miss notices are enabled.
- **0.84.4** (source L269): Added inherited experimental vision-capable `deepseek-v4-flash-vision-exp` model support.
- **0.84.4** (source L289): Fixed Google Vertex requests failing with `HttpsProxyAgent is not a constructor` when the bundled Node.js runtime uses an HTTP(S) proxy
- **0.84.4** (source L290): Fixed saving a default model from a non-empty model scope so it remains available in that scope.
- **0.84.4** (source L292): Fixed inherited OpenAI-compatible streams serializing thinking signatures repeatedly during streaming
- **0.84.4** (source L293): Fixed inherited main-screen rendering crashing when image-heavy output exceeded V8's string length limit
- **0.84.4** (source L295): Fixed inherited Cloudflare AI Gateway catalogs omitting supported `workers-ai/*` passthrough models.
- **0.84.4** (source L296): Fixed inherited OpenAI-compatible reasoning replay to merge consecutive streamed text and summary `reasoning_details` deltas.
- **0.84.4** (source L297): Fixed inherited OpenRouter reasoning controls so reasoning-mandatory models do not receive `effort: "none"`
- **0.84.4** (source L298): Fixed inherited OpenAI-compatible Chat Completions ignoring an explicitly requested `toolChoice` when no tools are defined.
- **0.84.4** (source L299): Fixed inherited fragmented Mistral tool calls splitting when continuation chunks omit the tool-call ID
- **0.84.3** (source L320): Added inherited provider-neutral `toolChoice` support to simple stream requests.
- **0.84.3** (source L321): Added inherited automatic Anthropic server-side refusal fallback for supported first-party models, including returned-model usage pricing
- **0.84.3** (source L322): Added inherited configurable OpenAI-compatible thinking-token budget fields for vLLM, Qwen/SGLang, and llama.cpp servers.
- **0.84.3** (source L323): Added inherited China-specific ZAI Coding Plan models, including GLM-4.6V vision support and API-equivalent usage cost estimates
- **0.84.3** (source L324): Added inherited `deepseek-v4-pro-0813` support to the Qwen Token Plan Individual catalog
- **0.84.3** (source L329): Changed inherited built-in xAI models to use the Responses API with encrypted reasoning replay and made Grok 4.6 the default xAI model
- **0.84.3** (source L330): Changed inherited Anthropic, Azure OpenAI, Google, Mistral, and OpenAI adapters to send Pi's default `User-Agent` unless overridden
- **0.84.3** (source L342): Fixed `models.json` typings omitting the documented OpenAI-compatible `compat.supportsFinishReason` provider and model override
- **0.84.3** (source L343): Fixed `/model` and `/thinking` selections being persisted globally unless explicitly saved with Ctrl+S
- **0.84.3** (source L350): Fixed the default Cerebras model referencing an unavailable Z.AI model.
- **0.84.3** (source L351): Fixed inherited OpenAI-compatible Chat Completions reasoning replay to preserve and resend assistant-level `reasoning_details` verbatim and in order
- **0.84.3** (source L352): Fixed inherited Anthropic server-side fallback responses being priced with the requested model instead of the returned fallback model
- **0.84.3** (source L353): Fixed inherited GitHub Copilot login triggering model-policy rate limits by limiting policy updates, retrying model discovery once, and honoring server retry delays
- **0.84.3** (source L354): Fixed inherited Amazon Bedrock dropping and failing to replay opaque redacted reasoning from non-Anthropic models
- **0.84.3** (source L355): Fixed inherited Z.AI Coding Plan models deriving incomplete reasoning-effort metadata, including missing GLM-5.3 low, high, and max levels
- **0.84.3** (source L356): Fixed inherited DeepSeek V4 Flash on OpenCode and OpenCode Go omitting its supported low thinking level
- **0.84.3** (source L357): Fixed inherited Azure OpenAI Responses ignoring `toolChoice` in provider-specific stream requests.
- **0.84.3** (source L358): Fixed inherited Amazon Bedrock response hooks receiving only a synthesized request id instead of the raw response headers
- **0.84.3** (source L359): Fixed inherited Kimi usage reporting so top-level `cached_tokens` count as cache reads instead of normal input tokens
- **0.84.3** (source L360): Fixed inherited Google custom models ignoring `thinkingLevelMap`, which dropped extended thinking controls
- **0.84.3** (source L361): Fixed writes to `auth.json` and `models-store.json` overriding administrator-managed file permissions and ACLs
- **0.84.3** (source L368): Fixed built-in llama.cpp models disappearing from `/model` when `/llama` refreshed a configured server under `PI_OFFLINE`, and included idle-slept `sleeping` router models plus autoloadable unloaded presets in the selectable catalog
- **0.84.3** (source L370): Fixed Z.AI Coding Plan defaults referencing the removed GLM-5.1 model
- **0.84.3** (source L375): Fixed llama.cpp login guidance to direct users to `/llama` before `/model` when no local models are loaded
- **0.84.3** (source L376): Fixed hung pi.dev model catalog requests consuming the entire refresh deadline without retrying
- **0.84.3** (source L377): Fixed inherited Xiaomi model catalogs listing shut-down MiMo V2 models in `/model` and `--list-models`
- **0.84.2** (source L405): Changed inherited Kimi Coding requests to use pi's runtime `User-Agent` header.
- **0.84.2** (source L406): Replaced the inherited Mistral SDK transport with a native Chat Completions HTTP stream, eliminating its generated client and schema runtime overhead.
- **0.84.2** (source L416): Fixed opening a model selector immediately after startup cancelling and restarting the in-progress model catalog refresh.
- **0.84.2** (source L417): Fixed inherited GitHub Copilot login triggering API rate limits while enabling model policies by limiting concurrent policy updates
- **0.84.2** (source L429): Fixed inherited upstream request buffer failures not triggering automatic assistant retries.
- **0.84.2** (source L430): Fixed inherited built-in and custom DeepSeek API models sending output limits through an unsupported field.
- **0.84.2** (source L431): Fixed inherited Amazon Bedrock replay rejecting tool arguments that contain empty object keys while preserving all valid nested values
- **0.84.2** (source L432): Fixed inherited DeepSeek compatibility detection for base URLs whose hostname contains uppercase letters
- **0.84.2** (source L433): Fixed inherited Google Generative AI and Vertex AI responses with tool calls incorrectly treating output-limit or provider-error stops as normal tool use
- **0.84.1** (source L445): **Qwen Token Plan Individual** — Use the built-in provider for models documented for Individual subscriptions.
- **0.84.1** (source L446): **Authentication readiness checks** — Use `pi auth check` to verify provider or model credentials, optionally emitting the resolved credential.
- **0.84.1** (source L452): Added Qwen Token Plan Individual as a built-in provider with its documented subscription model catalog and the shared international `QWEN_TOKEN_PLAN_API_KEY`.
- **0.84.1** (source L453): Added `pi auth check` provider/model auth preflight with optional credential output

### SDK packaging and extension loading

**Local evidence:** package.json declares pi-coding-agent/pi-server/pi-tui peers; scripts/update-pi.sh updates all three; packages/ext/subagents/agent-runner.ts uses the public local SDK. No client or experimental/plugin import was found.

**Next action:** Align local dependencies with the deployed 0.87.1 runtime and retest imports. Reassess the apparently unused pi-server peer separately; the changelog alone does not prove the package is unavailable.

- **0.86.1** (source L89): Enabled Node's persistent compile cache before loading the bundled CLI runtime, reducing repeat launch time.
- **0.86.0** (source L131): Enabled Node's persistent compile cache before loading the bundled CLI runtime, reducing repeat launch time.
- **0.86.0** (source L139): Deferred the extension compiler and bundled virtual modules until a filesystem extension is loaded, reducing the baseline SDK import cost
- **0.85.1** (source L200): Fixed SDK import failures caused by unintentionally publishing internal experimental code and dependencies in 0.85.0. The experimental `client` and `experimental/plugin` subpaths and server/client commands are now source-only through `pi-test.sh`; the supported local SDK and stdio RPC API are unchanged
- **0.85.0** (source L230): Restored the `@earendil-works/pi-coding-agent/client` compatibility entry point.
- **0.84.3** (source L334): Changed the bundled Node.js runtime to load jiti only when importing an extension and Babel only when uncached source needs transformation, reducing CLI startup time and bundle size.
- **0.84.3** (source L336): Changed the Node.js CLI and RPC entrypoints to load a bundled runtime, reducing startup filesystem reads while keeping the public library and legacy module paths on the modular runtime for normal dependency identity.
- **0.84.3** (source L345): Fixed extensions failing to load when the Node.js CLI runs as a single-executable application
- **0.84.1** (source L465): Fixed Bun standalone binaries crashing on startup when the cwd contains a `bunfig.toml` with `preload` by compiling with `--no-compile-autoload-bunfig`

### Extension registration and UI prompt lifecycle

**Local evidence:** packages/ext/index.ts registers extensions once; packages/ext/bash-gate/index.ts registers flags and presents approval UI; packages/ext/notifications.ts tracks a custom bash-gate event bus.

**Next action:** Keep existing hooks; consider ui_prompt_start/end only when tracking all UI waits is desired. Use pi.on unsubscribe for genuinely temporary subscriptions, not a blanket lifecycle rewrite.

- **0.86.0** (source L124): Added an unsubscribe function from `pi.on()` so extensions can drop event handlers. Handlers added or removed during a dispatch apply to later dispatches, not the current one
- **0.86.0** (source L125): Exported extension hook event and result types that were previously omitted from the package entry points
- **0.84.4** (source L258): **Extension UI prompt events** — Integrations can distinguish active agent work from time spent waiting for `ctx.ui` prompts.
- **0.84.4** (source L267): Added `ui_prompt_start` and `ui_prompt_end` extension events so host integrations can distinguish active agent work from waiting on user-facing `ctx.ui` prompts
- **0.84.3** (source L341): Fixed failed extension factories leaving event subscriptions, provider registrations, and default flag state active
- **0.84.3** (source L369): Fixed `pi.registerFlag()` accepting default values that do not match the declared flag type

### Session persistence, navigation and recovery

**Local evidence:** packages/ext/subagents/agent-runner.ts manages SDK sessions; packages/ext/goal/fork-inheritance.ts and packages/ext/footer/index.ts read session entries.

**Next action:** Exercise fork/resume/compaction preservation after updating dependencies; inherit upstream persistence fixes rather than adding local JSONL workarounds.

- **0.86.0** (source L132): Made `--resume` session results appear progressively, using file modification times to prioritize all-folder loading and cancelling outstanding transcript reads after selection.
- **0.86.0** (source L133): Reduced `--continue` startup time by checking candidate session headers in modification-time order and stopping after the newest matching session.
- **0.86.0** (source L163): Fixed exact session ID lookup scanning complete transcript bodies instead of reading session headers
- **0.85.0** (source L210): **Restorable in-memory sessions** — Resume externally stored session entries through the SDK.
- **0.85.0** (source L236): Fixed concurrent session shares overwriting one another
- **0.85.0** (source L238): Fixed imported sessions overwriting an existing session with the same filename
- **0.85.0** (source L239): Fixed session forks losing their compaction boundary
- **0.85.0** (source L240): Fixed in-memory session forks before an active turn settled
- **0.84.4** (source L285): Fixed resumed sessions corrupting the next appended entry when their JSONL file lacks a trailing newline
- **0.84.3** (source L337): Changed session sharing to render clickable terminal links, display only the canonical Radius artifact URL, and include the current system prompt and active tool definitions in Radius session shares.
- **0.84.3** (source L378): Fixed branch summary entries recording the navigation destination in `fromId` instead of the pre-navigation source leaf.

### CLI/RPC inputs and diagnostics

**Local evidence:** scripts/goal-model-smoke.sh uses --mode json; packages/ext/prompt-normalization/index.ts and packages/ext/inline-references/index.ts handle input; subagents use the SDK rather than the upstream example.

**Next action:** Keep valid --mode json; smoke-test RPC steering through input handlers if used. Treat improved streamed usage/tool IDs as upstream fixes, not a reason to replace the SDK.

- **0.87.1** (source L35): Fixed missing or invalid `--mode` values being silently ignored instead of reporting an error and exiting with a nonzero status
- **0.86.0** (source L169): Fixed direct RPC `steer` and `follow_up` commands bypassing extension `input` handlers
- **0.84.4** (source L259): **RPC queue clearing** — Retrieve and clear queued steering and follow-up messages with `clear_queue`.
- **0.84.4** (source L271): Added RPC `clear_queue` to retrieve and remove queued steering and follow-up messages
- **0.84.3** (source L344): Fixed JSON and RPC `toolcall_start` events omitting the tool call id and name
- **0.84.3** (source L380): Fixed dash-prefixed prompts being parsed as options by supporting `--` as an end-of-options delimiter
- **0.84.2** (source L422): Fixed JSON and RPC `message_update` events dropping cumulative usage during streaming.

### Bug reports and crash attribution

**Local evidence:** packages/ext/subagents/diagnostics.ts records local subagent diagnostics; packages/ext/index.ts loads the extension collection.

**Next action:** Use /bug for host-level failures, inspecting shared diagnostics before upload; retain local subagent diagnostics and use offline ZIP export when needed.

- **0.87.0** (source L70): Fixed `/bug` allowing uploads in offline mode while preserving local zip exports
- **0.87.0** (source L72): Improved crash diagnostics with hints identifying loaded extensions that appear in the stack trace.
- **0.86.1** (source L93): Fixed `/bug` descriptions dropping line breaks from pasted diagnostics.
- **0.86.1** (source L94): Fixed `/bug` hints appearing for user cancellations and retryable provider failures such as service unavailability.
- **0.86.0** (source L104): **Bug reporting** — Report problems with `/bug` using redacted diagnostics, optional transcripts, or exported ZIP archives.
- **0.86.0** (source L126): Added `/bug [description]` to report a bug to the Pi developers. The report bundles environment, model, provider, extension, and settings metadata (secrets redacted), assistant message diagnostics from the session, optionally the session transcript, or a model-written summary of what went wrong instead. It is uploaded to Radius (no login required; attributed when logged in) or exported as a zip archive, and the report id is recorded in the session as a `pi.bug-report` entry. Crashes are recorded in `~/.pi/agent/crashes.json`, announced once on the next start, and attached to the next report; unexplained errors and exhausted retries point at `/bug` once per session.

### Prompt-cache warming

**Local evidence:** packages/ext/subagents/agent-runner.ts creates long-lived sessions and packages/ext/footer/index.ts reports usage/cost; no cache_warming_decision handler exists.

**Next action:** Evaluate native warming cost during long delegated tool runs before enabling idle warming; do not add a custom keepalive timer.

- **0.87.0** (source L71): Fixed idle prompt-cache warming rebuilding expired caches when its timer or an extension decision is delayed.
- **0.86.0** (source L103): **Prompt cache warming** — Keep valuable prompt caches alive during long tool runs and optionally while idle using cost-aware refreshes.
- **0.86.0** (source L127): Added cost-aware prompt-cache warming during long tool runs and optionally while idle, with configurable modes, model cache-lifetime metadata, `/session` diagnostics, transcript notices, and the `cache_warming_decision` extension event.

## Ignore

### No matching local implementation

**Local evidence:** Searches found no shouldStopAfterTurn, GoogleThinkingLevel, user_bash handler, Agent.reset call, Workers binding transport, or use of the upstream example agent loader. Installer/archive/nanoid items concern upstream distribution or development, not this Nix-hosted extension implementation; scripts/update-pi.sh uses bun rather than pi update.

**Next action:** No change.

- **0.87.0** (source L49): Removed the inherited `shouldStopAfterTurn` agent option. Use `finishTurn` and return `{ action: "end" }` instead. `finishTurn` runs before `turn_end` but applies the decision afterward, and it also receives error and aborted responses; migrate normal-response predicates by returning `undefined` for those hard exits. See the `@earendil-works/pi-agent-core` changelog for a complete before-and-after example.
- **0.86.0** (source L113): `user_bash` now fails closed: errors or invalid defined results abort the command without invoking later handlers or executing locally. Return `undefined` to continue propagation; otherwise return `{ operations }` or `{ result }`
- **0.84.3** (source L306): **Safer managed updates** — Stage, verify, and atomically activate updates for installer-managed installations.
- **0.84.3** (source L311): Renamed the inherited `GoogleThinkingLevel` type to `GoogleApiThinkingLevel` and added `ResolvedGoogleThinkingLevel` for normalized adapter levels.
- **0.84.3** (source L328): Changed experimental installer-managed installations so `pi update` stages, verifies, and atomically activates the selected release in place.
- **0.84.3** (source L332): Changed Bun release archives to ship the native clipboard binary only inside the wrapper package, removing a duplicate platform package from each archive.
- **0.84.3** (source L364): Fixed the subagent example repeatedly prompting before running project-local agents in trusted repositories
- **0.84.3** (source L367): Fixed npm package update checks treating older registry versions as available updates, preventing `pi update` from downgrading already-newer installed packages
- **0.84.2** (source L399): Added inherited `createGatewayBindingFetch()` for routing Cloudflare AI Gateway requests through a Workers AI binding without an API token
- **0.84.2** (source L407): Documented the generic `AI_AGENT=pi` process marker and how it differs from `PI_CODING_AGENT=true`
- **0.84.2** (source L420): Updated the transitive `nanoid` development dependency to address a denial-of-service vulnerability.
- **0.84.2** (source L425): Fixed the subagent example rejecting YAML array syntax for the `tools` frontmatter field
- **0.84.2** (source L426): Fixed the subagent example dropping parent session model, thinking, and tool configuration
- **0.84.1** (source L468): Fixed inherited `Agent.reset()` clearing transcript and runtime state during active runs; it now rejects until the agent is idle
