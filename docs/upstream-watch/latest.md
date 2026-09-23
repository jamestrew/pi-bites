# Pi upstream watch — 2026-09-23

Package: `@earendil-works/pi-coding-agent`
Checkpoint: `0.84.0`
Latest upstream: `0.87.1`

## Agent review checklist

Classify every entry below as `adapt`, `leverage`, `watch`, or `irrelevant`. Cross-reference local extension code before recommending action. Do not update `docs/upstream-watch/state.json` until the review is accepted.

Local surfaces to check first: `packages/ext/index.ts`, `packages/ext/config.ts`, `packages/ext/tools.ts`, `packages/ext/explore/`, `packages/ext/statusline.ts`, `packages/ext/notifications.ts`, `packages/ext/file-search/`, `packages/ext/inline-references/`, and docs under `README.md`.

## Upstream entries

## 0.87.1

### New Features

- **Latest frontier models** — Use Claude Opus 5.5, GPT-6 Sol, and GPT-6 Luna through supported providers, including GitHub Copilot. See [Choose a Model](docs/models.md#select-a-model).
- **Grok 4.7 by default for xAI** — New xAI sessions now default to Grok 4.7. See [Provider Authentication](docs/providers.md#use-an-api-key-from-the-environment).

### Added

- Added inherited Claude Opus 5.5, GPT-6 Sol, and GPT-6 Luna support for GitHub Copilot.
- Added inherited GPT-6 Sol and GPT-6 Luna support for OpenAI API keys and OpenAI Codex subscriptions.
- Added inherited Claude Opus 5.5 support for Anthropic with adaptive thinking and a 1M context window.

### Changed

- Changed the default xAI model to Grok 4.7.

### Fixed

- Fixed split-turn compaction summaries being refused by Claude Fable 5.1 by clearly separating the conversation and using continuation-oriented instructions ([#9908](https://github.com/earendil-works/pi/pull/9908) by [@davidbrai](https://github.com/davidbrai)).
- Fixed missing or invalid `--mode` values being silently ignored instead of reporting an error and exiting with a nonzero status ([#9045](https://github.com/earendil-works/pi/issues/9045)).
- Fixed inherited image-only user messages being rejected by some OpenAI-compatible providers because they included an empty text part ([#9797](https://github.com/earendil-works/pi/issues/9797)).
- Fixed inherited Anthropic OAuth requests reporting an outdated Claude Code version.

## 0.87.0

### New Features

- **Canonical session context and extension boundaries** — Edit model context without rewriting history and add actionable lifecycle hooks. See [ContextEditEntry](docs/session-format.md#contexteditentry) and [extension events](docs/extensions.md#extension-events).
- **Full-transcript context extensions** — Use `context_with_system` for per-request system-message transformations. See [`context_with_system`](docs/extensions.md#context_with_system).
- **Per-model image input limits** — Configure cache-safe image resizing per model for attachments, `read`, and tool-result images. See [Image Input Limits](docs/models.md#image-input-limits).

### Breaking Changes

- Removed the inherited `shouldStopAfterTurn` agent option. Use `finishTurn` and return `{ action: "end" }` instead. `finishTurn` runs before `turn_end` but applies the decision afterward, and it also receives error and aborted responses; migrate normal-response predicates by returning `undefined` for those hard exits. See the `@earendil-works/pi-agent-core` changelog for a complete before-and-after example.
- Added `ContextEditEntry` to the exported `SessionEntry` union. TypeScript consumers with exhaustive entry switches must handle `context_edit`; use `replacement: null` for omission and a content replacement otherwise.
- Made `SessionManager` canonical for `AgentSession` provider context. Assigning `session.agent.state.messages` no longer replaces future request history; restore with `SessionManager.inMemory(cwd, { id }, entries)`, navigate with `session.navigateTree()`, or append through `session.sessionManager` and call `session.refreshContext()`.
- Expanded `TurnEndEvent` with required boundary fields and added `AgentBeforeSettleEvent` to the exported `ExtensionEvent` union. Consumers constructing events or exhaustively switching on `ExtensionEvent` must handle the new shapes. `ExtensionRunner.emit()` no longer accepts `turn_end`; host integrations dispatch actionable boundaries with `emitBoundary(baseEvent, buildContext)`.
- Deferred runs requested from `agent_settled` handlers until all settled handlers finish. Handlers still observe `ctx.isIdle() === true`, but no longer see a reentrant `agent_start` during the same notification dispatch.

### Added

- Added append-only model-context edits. For example, `sessionManager.appendContextEdit(entryId, null)` omits one message from future provider context without changing raw history, usage, or UI history.
- Added actionable `turn_end` and `agent_before_settle` extension boundaries. Return `{ entries: [...event.entries, draft], continue: true }` to persist structural entries in order and ensure one next provider request without changing steering or follow-up scheduling.
- Added retain-none compaction input: `sessionManager.appendCompaction(summary, null, tokensBefore)` stores the compaction's own ID as its kept boundary.
- Added the `context_with_system` extension event, which runs after `context` handlers on the full transcript including system messages and sends its result verbatim. See [`context_with_system`](docs/extensions.md#context_with_system).
- Added per-model image resize profiles through `inputLimits.images.resize` in `models.json`, applied to file attachments, image reads, and tool-result images ([#9631](https://github.com/earendil-works/pi/issues/9631)).

### Fixed

- Fixed string context-edit replacements producing invalid assistant and tool-result message content instead of text blocks.
- Fixed context-invisible boundary metadata and replacement edits causing newly appended or replaced input to be summarized before its first provider request.
- Fixed edited-context accounting both discarding valid assistant usage captured after the latest context edit and reusing that usage after a later compaction made it stale.
- Fixed selected error retries and final length/overflow recovery retaining abandoned model attempts in future provider context; post-run recovery omissions are now persisted without hiding raw transcript history or changing queue scheduling.
- Fixed `context` handlers that filter or slice messages dropping the prompt and tool declarations, which after extension-driven compaction left requests without built-in tools or made Codex emit raw tool-call text. Handlers no longer see system messages; Pi restores the prompt and tool state after they run. See [`context`](docs/extensions.md#context) ([#9789](https://github.com/earendil-works/pi/issues/9789), [#9822](https://github.com/earendil-works/pi/issues/9822)).
- Fixed `/bug` allowing uploads in offline mode while preserving local zip exports ([#9841](https://github.com/earendil-works/pi/pull/9841) by [@christianklotz](https://github.com/christianklotz)).
- Fixed idle prompt-cache warming rebuilding expired caches when its timer or an extension decision is delayed.
- Improved crash diagnostics with hints identifying loaded extensions that appear in the stack trace.
- Fixed text files beginning with `GIF` being misclassified as images and omitted from `read` and CLI `@file` input ([#9755](https://github.com/earendil-works/pi/issues/9755)).
- Fixed malformed prompt template frontmatter being silently ignored instead of reported as a resource warning ([#9830](https://github.com/earendil-works/pi/pull/9830) by [@christianklotz](https://github.com/christianklotz)).
- Fixed inherited unknown OpenAI-compatible Chat Completions endpoints receiving strict tool schemas unless they explicitly advertise support ([#9816](https://github.com/earendil-works/pi/issues/9816)).

## 0.86.1

### New Features

- **Meta Muse provider** — Sign in with Meta using `/login meta` or use `META_API_KEY` to access Muse Spark models. See [Meta (Muse subscription)](docs/providers.md#meta-muse-subscription).

### Added

- Added Meta (Muse subscription) login via `/login meta` with automatic Model API key refresh, plus `META_API_KEY` support ([#9096](https://github.com/earendil-works/pi/pull/9096) by [@xl0](https://github.com/xl0)).

### Changed

- Enabled Node's persistent compile cache before loading the bundled CLI runtime, reducing repeat launch time.

### Fixed

- Fixed `/bug` descriptions dropping line breaks from pasted diagnostics.
- Fixed `/bug` hints appearing for user cancellations and retryable provider failures such as service unavailability.
- Fixed clipboard copy failing in containers and WSL without WSLg by restoring the OSC 52 fallback when no display is available, and added a verified Windows clipboard backend for WSL ([#9688](https://github.com/earendil-works/pi/issues/9688)).
- Fixed inherited z.ai `Prompt too long` errors not being recognized as context overflow ([#9805](https://github.com/earendil-works/pi/issues/9805)).
- Fixed inherited Cerebras models advertising unsupported strict tool schemas, which caused HTTP 400 errors when strict and non-strict tools were mixed ([#9804](https://github.com/earendil-works/pi/pull/9804) by [@EdenGottlieb](https://github.com/EdenGottlieb)).

## 0.86.0

### New Features

- **Prompt cache warming** — Keep valuable prompt caches alive during long tool runs and optionally while idle using cost-aware refreshes. See [Cache Warming](docs/settings.md#cache-warming).
- **Bug reporting** — Report problems with `/bug` using redacted diagnostics, optional transcripts, or exported ZIP archives. See [Reporting Bugs](docs/sessions.md#reporting-bugs).
- **Transcript-aware prompt and tool updates** — Preserve instruction and tool changes across resume and branch navigation while retaining cached prefixes. See [`before_agent_start`](docs/extensions.md#before_agent_start).
- **Offline Radius model catalog** — Select Radius models immediately, with cached and live catalogs overlaid when available. See [Radius](docs/providers.md#radius).
- **Per-model compaction budgets** — Configure reserved and recent-token budgets by model. See [Per-model overrides](docs/compaction.md#per-model-overrides).

### Breaking Changes

- Changed inherited pi-ai provider stream inputs from `Context` to normalized `TranscriptContext` values. Custom providers must read system prompts and tool declarations from `context.messages` with `getCurrentSystemPrompt()` and `getCurrentTools()`. See [Custom Streaming API](docs/custom-provider.md#custom-streaming-api).
- Restricted inherited `ToolCall.arguments` and `ToolResultMessage.details` to JSON-compatible values, changed `ToolResultMessage` into a conditional type, and made `JsonValue` arrays readonly.
- `user_bash` now fails closed: errors or invalid defined results abort the command without invoking later handlers or executing locally. Return `undefined` to continue propagation; otherwise return `{ operations }` or `{ result }` ([#9068](https://github.com/earendil-works/pi/issues/9068)).

### Added

- Added transcript-backed mid-conversation system prompt and tool changes so instruction and tool updates survive resume and branch navigation while preserving cached prefixes on supported models. See [`before_agent_start`](docs/extensions.md#before_agent_start) and [Entry Types](docs/session-format.md#entry-types) ([#9548](https://github.com/earendil-works/pi/pull/9548)).
- Added inherited native deferred tool loading for Fireworks Messages models. Use `ToolSearch` or `tool_search` as the loader name for prompt-prefix deferral ([#9323](https://github.com/earendil-works/pi/issues/9323)).
- Added click toggling for branch summaries, compaction summaries, and skill invocation entries.
- Added the public Radius model catalog for immediate and offline model selection, with cached and live gateway catalogs overlaid when available.
- Added `ctx.modelRegistry.stream()` and `streamSimple()` for extension model calls through configured providers with resolved authentication ([#8964](https://github.com/earendil-works/pi/issues/8964)).
- Added per-model `reserveTokens` and `keepRecentTokens` settings through `compaction.modelOverrides`, with ordinary compaction settings as fallback ([#8133](https://github.com/earendil-works/pi-mono/issues/8133)).
- Added `compat.allowedFallbackModels` configuration for overriding or disabling Anthropic server-side fallback models ([#9294](https://github.com/earendil-works/pi/issues/9294)).
- Added an unsubscribe function from `pi.on()` so extensions can drop event handlers. Handlers added or removed during a dispatch apply to later dispatches, not the current one ([#8967](https://github.com/earendil-works/pi/issues/8967)).
- Exported extension hook event and result types that were previously omitted from the package entry points ([#9642](https://github.com/earendil-works/pi/pull/9642)).
- Added `/bug [description]` to report a bug to the Pi developers. The report bundles environment, model, provider, extension, and settings metadata (secrets redacted), assistant message diagnostics from the session, optionally the session transcript, or a model-written summary of what went wrong instead. It is uploaded to Radius (no login required; attributed when logged in) or exported as a zip archive, and the report id is recorded in the session as a `pi.bug-report` entry. Crashes are recorded in `~/.pi/agent/crashes.json`, announced once on the next start, and attached to the next report; unexplained errors and exhausted retries point at `/bug` once per session.
- Added cost-aware prompt-cache warming during long tool runs and optionally while idle, with configurable modes, model cache-lifetime metadata, `/session` diagnostics, transcript notices, and the `cache_warming_decision` extension event. See [Cache Warming](docs/settings.md#cache-warming) ([#9668](https://github.com/earendil-works/pi/pull/9668)).

### Changed

- Enabled Node's persistent compile cache before loading the bundled CLI runtime, reducing repeat launch time.
- Made `--resume` session results appear progressively, using file modification times to prioritize all-folder loading and cancelling outstanding transcript reads after selection.
- Reduced `--continue` startup time by checking candidate session headers in modification-time order and stopping after the newest matching session.
- Replaced the external native clipboard dependency with bundled asynchronous macOS, Windows, and X11 helpers while preserving platform command and OSC 52 fallbacks ([#9163](https://github.com/earendil-works/pi/pull/9163)).
- Reduced inherited fuzzy search latency for long texts by using native substring search instead of scanning each character in JavaScript ([#9267](https://github.com/earendil-works/pi/issues/9267)).
- Moved compaction, branch summarization, and retry spinners into the editor border alongside the working indicator. Custom editors use the same embedding opt-in for all status spinners.
- Enabled strict-prefer JSON-schema sampling by default for built-in `read`, `bash`, `powershell`, `edit`, and `write` tools, without requiring `PI_EXPERIMENTAL`. Extensions can re-register tool definitions with `constrainedSampling: false`.
- Formatted Bash and PowerShell tool durations of at least one minute as minutes and seconds, with hours when needed ([#9628](https://github.com/earendil-works/pi/issues/9628)).
- Deferred the extension compiler and bundled virtual modules until a filesystem extension is loaded, reducing the baseline SDK import cost ([#9540](https://github.com/earendil-works/pi/issues/9540)).

### Fixed

- Fixed GitHub Copilot GPT models, including GPT-6 Astra, using the Chat Completions adapter instead of the required Responses adapter ([#9253](https://github.com/earendil-works/pi/pull/9253) by [@petrroll](https://github.com/petrroll)).
- Fixed inherited DeepSeek V4.1 thinking levels on OpenRouter and OpenCode Go preserving provider effort metadata ([#9485](https://github.com/earendil-works/pi/issues/9485)).
- Fixed inherited bodyless HTTP 400/413 errors from non-Cerebras providers being misclassified as context overflow ([#9482](https://github.com/earendil-works/pi/issues/9482)).
- Fixed inherited Vercel AI Gateway replaying unsigned thinking as assistant text ([#9676](https://github.com/earendil-works/pi/issues/9676)).
- Fixed inherited Google Generative AI and Vertex AI using unsupported thinking levels when reasoning is omitted or when model capabilities differ within a Gemini family ([#9455](https://github.com/earendil-works/pi/issues/9455)).
- Fixed inherited Anthropic-compatible relays breaking signed thinking replay when they report a different response model, while preserving fallback pricing ([#9188](https://github.com/earendil-works/pi/issues/9188)).
- Fixed inherited Amazon Bedrock one-hour cache writes being priced at the five-minute rate ([#9457](https://github.com/earendil-works/pi/issues/9457)).
- Fixed inherited quadratic CPU usage when draining buffered `EventStream` events ([#9055](https://github.com/earendil-works/pi/issues/9055)).
- Fixed inherited Mistral Medium reasoning requests to use `reasoning_effort` for all reasoning-capable `mistral-medium-*` model IDs instead of the unsupported `prompt_mode` ([#8700](https://github.com/earendil-works/pi/issues/8700)).
- Fixed inherited OpenCode and OpenCode Go requests to send `x-opencode-session` from `sessionId` across all supported API adapters ([#9326](https://github.com/earendil-works/pi/issues/9326)).
- Fixed inherited OpenAI Codex requests to send the model's Off reasoning effort instead of omitting it, while respecting unsupported Off mappings ([#9191](https://github.com/earendil-works/pi/issues/9191)).
- Fixed inherited Fireworks unsigned thinking replay and reasoning effort selection using catalog metadata, with verified DeepSeek V4 and Qwen3.8 fallbacks and removal of redundant GLM 5.2 and Kimi K3 effort aliases ([#9323](https://github.com/earendil-works/pi/issues/9323)).
- Fixed inherited OpenRouter requests to send `x-session-id` from `sessionId` for Chat Completions and Anthropic Messages models when prompt caching is enabled ([#9102](https://github.com/earendil-works/pi/issues/9102)).
- Fixed the inherited DeepSeek catalog to advertise `deepseek-flash` for DeepSeek V4.1 Flash instead of retired Flash aliases, and refreshed DeepSeek pricing metadata ([#9423](https://github.com/earendil-works/pi/issues/9423)).
- Fixed inherited Mistral-hosted GLM-5.2 reasoning requests to use `reasoning_effort` instead of the ignored `prompt_mode` ([#9375](https://github.com/earendil-works/pi/issues/9375)).
- Fixed inherited OpenAI-compatible Responses errors to identify the actual provider instead of always labeling them as OpenAI errors ([#9298](https://github.com/earendil-works/pi/issues/9298)).
- Fixed inherited Baseten requests to send session-affinity headers from `sessionId` for automatic prompt-cache routing ([#9629](https://github.com/earendil-works/pi/issues/9629)).
- Fixed inherited retry classification for Cloudflare 520 responses ([#9627](https://github.com/earendil-works/pi/issues/9627)).
- Fixed inherited retry classification for transient Azure peak-load capacity errors ([#9669](https://github.com/earendil-works/pi/issues/9669)).
- Fixed session tree navigation racing with active compaction and replacing its progress UI ([#9179](https://github.com/earendil-works/pi/pull/9179) by [@acmerfight](https://github.com/acmerfight)).
- Fixed exact session ID lookup scanning complete transcript bodies instead of reading session headers ([#9601](https://github.com/earendil-works/pi/pull/9601) by [@metaist](https://github.com/metaist)).
- Fixed repeated Anthropic thinking-drop notices being shown for the same dropped blocks, and shortened notices while retaining details in the session ([#9391](https://github.com/earendil-works/pi/issues/9391)).
- Fixed mid-run threshold compaction silently skipping oversized trailing tool results ([#9740](https://github.com/earendil-works/pi/issues/9740)).
- Fixed signal-terminated local shell commands being reported as successful with partial output ([#9577](https://github.com/earendil-works/pi/issues/9577) by [@BrendanJMurphy](https://github.com/BrendanJMurphy)).
- Fixed local clipboard failures reporting success when the terminal ignored the fallback OSC 52 write, and added platform-specific setup guidance when no clipboard backend works ([#9618](https://github.com/earendil-works/pi/issues/9618)).
- Capped agent-level retry backoff at `retry.maxAgentDelayMs` (60s by default) so long retry runs stay responsive during prolonged transient outages ([#8826](https://github.com/earendil-works/pi/issues/8826)).
- Fixed direct RPC `steer` and `follow_up` commands bypassing extension `input` handlers ([#8718](https://github.com/earendil-works/pi/issues/8718)).
- Fixed premature missing-model errors after login by waiting for catalog discovery. Radius now defaults to `balanced`, falling back to the first available Radius model when needed.
- Fixed fullscreen mode reserving a blank row for custom footers that render zero rows ([#8919](https://github.com/earendil-works/pi/issues/8919)).
- Fixed extension tools without parameter schemas to be rejected during registration instead of breaking provider requests ([#9300](https://github.com/earendil-works/pi/issues/9300)).
- Fixed `before_agent_start` handlers returning `systemPrompt` (and `forceSystemPrompt`) on models with mid-conversation system messages: the forced prompt is now sent as the provider's leading system prompt instead of being appended as a section patch after the original prompt.
- Fixed loaded llama.cpp models with `enable_thinking` chat templates ignoring Pi's thinking level ([#9528](https://github.com/earendil-works/pi/issues/9528)).
- Fixed cancellation races that could start automatic compaction, leave stale retry state, or miss cancellation while waiting for summarization authentication ([#9340](https://github.com/earendil-works/pi/issues/9340), [#9777](https://github.com/earendil-works/pi/issues/9777)).
- Fixed asynchronous Kitty image conversion replacing newer partial tool output images ([#8743](https://github.com/earendil-works/pi/pull/8743) by [@wutongyuonce](https://github.com/wutongyuonce)).
- Fixed inherited skill slash-command autocomplete ranking the `skill:` prefix instead of the bare skill name ([#9120](https://github.com/earendil-works/pi/pull/9120) by [@yearth](https://github.com/yearth)).
- Fixed inherited file autocomplete boundaries and path quoting around CJK punctuation ([#9746](https://github.com/earendil-works/pi/pull/9746) by [@haoqixu](https://github.com/haoqixu)).
- Fixed inherited LaTeX legacy font switches falling back to raw source, centered `cases` layouts around surrounding equations, and vertically laid out unsupported and nested display scripts ([#8827](https://github.com/earendil-works/pi/issues/8827), [#9564](https://github.com/earendil-works/pi/issues/9564), [#7929](https://github.com/earendil-works/pi/issues/7929)).
- Fixed inherited fullscreen Kitty images being erased by later row clears in WezTerm ([#9169](https://github.com/earendil-works/pi/issues/9169)).

### Removed

- Removed unavailable inherited GPT-5.4 and GPT-5.4 mini models from OpenAI Codex selection ([#9394](https://github.com/earendil-works/pi/issues/9394)).

## 0.85.1

### New Features

- **GPT-6 Astra** — Available through OpenAI API keys and OpenAI Codex subscriptions. See [API Keys](docs/providers.md#api-keys) and [OpenAI Codex](docs/providers.md#openai-codex).

### Added

- Added GPT-6 Astra for OpenAI API keys and OpenAI Codex subscriptions.
- Added five-times-faster mouse wheel scrolling while holding Alt in fullscreen mode ([#9166](https://github.com/earendil-works/pi/pull/9166) by [@xl0](https://github.com/xl0)).

### Fixed

- Fixed configurable save keybindings in the model and thinking selectors ([#9149](https://github.com/earendil-works/pi/pull/9149) by [@rwachtler](https://github.com/rwachtler)).
- Fixed SDK import failures caused by unintentionally publishing internal experimental code and dependencies in 0.85.0. The experimental `client` and `experimental/plugin` subpaths and server/client commands are now source-only through `pi-test.sh`; the supported local SDK and stdio RPC API are unchanged ([#9132](https://github.com/earendil-works/pi/issues/9132)).
- Fixed mouse hover changing selection and recentering autocomplete and settings lists, causing clicks to target a different item.
- Fixed long prompt-cache requests for GPT-5.6+ Responses models to use `prompt_cache_options.ttl: "30m"` instead of `prompt_cache_retention: "24h"`.

## 0.85.0

### New Features

- **Persistent Claude thinking effort** — Supported Anthropic transports preserve per-turn effort and recover safely from signed-thinking mismatches. See [Model Configuration](docs/models.md#model-configuration).
- **Fullscreen transcript controls** — Jump to the latest message from a scrolled transcript and use the embedded working indicator. See [TUI Fullscreen Viewport](docs/keybindings.md#tui-fullscreen-viewport).
- **Restorable in-memory sessions** — Resume externally stored session entries through the SDK. See [Session Management](docs/sdk.md#session-management).

### Added

- Added `SessionManager.inMemory()` support for restoring externally managed session entries ([#8980](https://github.com/earendil-works/pi/pull/8980) by [@y-nk](https://github.com/y-nk)).
- Added inherited OpenAI-compatible `vllmPriority` and `supportsMaxOutputTokens` model settings for vLLM scheduler priority and OpenAI Responses output-token limits ([#9004](https://github.com/earendil-works/pi/pull/9004) by [@AppleDannyClegg](https://github.com/AppleDannyClegg), [#8941](https://github.com/earendil-works/pi/pull/8941) by [@scturtle](https://github.com/scturtle)).
- Added inherited LaTeX rendering for relational algebra join symbols ([#9050](https://github.com/earendil-works/pi/pull/9050) by [@haoqixu](https://github.com/haoqixu)).
- Added a clickable "Jump to latest message" label with the `tui.altScreen.bottom` shortcut to the fullscreen transcript while it is scrolled up ([#9080](https://github.com/earendil-works/pi/pull/9080) by [@rwachtler](https://github.com/rwachtler)).
- Added Meta (Muse subscription) login via `/login meta` with automatic Model API key refresh, plus `META_API_KEY` support.

### Changed

- Moved the streaming working indicator into the default editor border and matched its default spinner and label to the thinking-level border color. Custom editors retain the standalone indicator unless they opt in to embedding it ([#8799](https://github.com/earendil-works/pi/pull/8799) by [@cristinaponcela](https://github.com/cristinaponcela)).
- Reduced inherited fullscreen transcript search latency on large transcripts by caching unchanged search results, indexing ASCII runs, and limiting highlight work to visible matches ([#8800](https://github.com/earendil-works/pi/pull/8800) by [@cristinaponcela](https://github.com/cristinaponcela)).

### Fixed

- Fixed managed `fd` and ripgrep downloads on Linux musl systems ([#9070](https://github.com/earendil-works/pi/pull/9070) by [@Charlie0113-T](https://github.com/Charlie0113-T)).
- Removed the unavailable inherited Grok Build 0.1 model from `/model` ([#9093](https://github.com/earendil-works/pi/pull/9093) by [@Jaaneek](https://github.com/Jaaneek)).
- Fixed inherited provider streams emitting incompatible event sequences and custom tool-call deltas.
- Restored the `@earendil-works/pi-coding-agent/client` compatibility entry point.
- Fixed the inherited Qwen Token Plan Individual catalog to include Qwen3.8 Flash ([#9021](https://github.com/earendil-works/pi/issues/9021)).
- Fixed inherited OpenAI Codex SSE parsing to process terminal events that are not followed by a blank line ([#9047](https://github.com/earendil-works/pi/issues/9047)).
- Fixed inherited GitHub Copilot Claude Fable 5 requests so selected reasoning levels are sent ([#8961](https://github.com/earendil-works/pi/issues/8961)).
- Fixed inherited Baseten GLM-5.2 models incorrectly advertising image input support ([#8293](https://github.com/earendil-works/pi/pull/8293) by [@Panoplos](https://github.com/Panoplos)).
- Fixed skills being unavailable when Bash is the only enabled tool ([#8552](https://github.com/earendil-works/pi/pull/8552) by [@xl0](https://github.com/xl0)).
- Fixed concurrent session shares overwriting one another ([#8613](https://github.com/earendil-works/pi/pull/8613) by [@wutongyuonce](https://github.com/wutongyuonce)).
- Fixed image orientation detection skipping EXIF data after non-EXIF APP1 segments ([#8616](https://github.com/earendil-works/pi/pull/8616) by [@wutongyuonce](https://github.com/wutongyuonce)).
- Fixed imported sessions overwriting an existing session with the same filename ([#8985](https://github.com/earendil-works/pi/pull/8985) by [@wutongyuonce](https://github.com/wutongyuonce)).
- Fixed session forks losing their compaction boundary ([#8990](https://github.com/earendil-works/pi/pull/8990) by [@acmerfight](https://github.com/acmerfight)).
- Fixed in-memory session forks before an active turn settled ([#8937](https://github.com/earendil-works/pi/pull/8937) by [@acmerfight](https://github.com/acmerfight)).
- Fixed inherited Fireworks GLM models using the wrong API adapter.
- Fixed inherited `NO_PROXY` matching for root domains and subdomains ([#8737](https://github.com/earendil-works/pi/pull/8737) by [@MeiSiristhebest](https://github.com/MeiSiristhebest)).
- Fixed `bash`, `edit`, `find`, `grep`, `ls`, `read`, and `write` tools ignoring `ctx.cwd` ([#8627](https://github.com/earendil-works/pi/pull/8627) by [@vmizg](https://github.com/vmizg)).
- Fixed inherited terminal startup under restricted seccomp policies that reject the `SIGWINCH` self-signal ([#8898](https://github.com/earendil-works/pi/pull/8898) by [@bartlomiejkida](https://github.com/bartlomiejkida)).
- Fixed inherited Zed terminal image capability detection ([#8828](https://github.com/earendil-works/pi/pull/8828) by [@Perlence](https://github.com/Perlence)).
- Fixed drag selection continuing over the fullscreen editor.
- Fixed managed `fd` and ripgrep downloads requiring the GitHub Releases API ([#8708](https://github.com/earendil-works/pi/pull/8708) by [@Terminator666666](https://github.com/Terminator666666)).
- Fixed branch summaries failing when reasoning consumes the previous 2048-token output cap ([#8845](https://github.com/earendil-works/pi/issues/8845)).
- Fixed the write tool reporting UTF-16 code-unit counts as byte counts by removing the misleading count ([#8979](https://github.com/earendil-works/pi/issues/8979)).
- Fixed proxied plain-HTTP provider requests hanging after a tool call by tunneling them with CONNECT ([#8134](https://github.com/earendil-works/pi/issues/8134)).
- Fixed RPC `abort` reporting success without cancelling an in-progress manual compaction ([#8920](https://github.com/earendil-works/pi/issues/8920)).

## 0.84.4

### New Features

- **Terminal capability overrides** — Override detected terminal hyperlink, image, and truecolor support. See [Capability Overrides](docs/terminal-setup.md#capability-overrides).
- **Extension UI prompt events** — Integrations can distinguish active agent work from time spent waiting for `ctx.ui` prompts. See [Extension UI prompt events](docs/extensions.md#ui_prompt_start--ui_prompt_end).
- **RPC queue clearing** — Retrieve and clear queued steering and follow-up messages with `clear_queue`. See [RPC `clear_queue`](docs/rpc.md#clear_queue).
- **Fullscreen selection copy controls** — Disable automatic selection copying in fullscreen mode and use Ctrl+X to copy the active selection. See [UI & Display](docs/settings.md#ui--display).
- **DeepSeek V4 Flash Vision (experimental)** — Use the vision-capable model through the built-in DeepSeek provider. See [API Keys](docs/providers.md#api-keys).

### Added

- Added `supportsMidConvoEffort` to custom Anthropic Messages model compatibility settings.
- Added transcript notices for Anthropic thinking blocks dropped during provider recovery when cache miss notices are enabled.
- Added `ui_prompt_start` and `ui_prompt_end` extension events so host integrations can distinguish active agent work from waiting on user-facing `ctx.ui` prompts ([#8355](https://github.com/earendil-works/pi/pull/8355) by [@cristinaponcela](https://github.com/cristinaponcela)).
- Added `detectSupportedImageMimeTypeFromFile()` to the public library exports ([#8600](https://github.com/earendil-works/pi/pull/8600) by [@xl0](https://github.com/xl0)).
- Added inherited experimental vision-capable `deepseek-v4-flash-vision-exp` model support.
- Added transcript usage notices for compaction and branch summaries when cache miss notices are enabled.
- Added RPC `clear_queue` to retrieve and remove queued steering and follow-up messages ([#8432](https://github.com/earendil-works/pi/issues/8432)).
- Added environment variables and advanced settings for overriding auto-detected terminal hyperlink, image, and truecolor capabilities ([#8665](https://github.com/earendil-works/pi/issues/8665)).
- Added `fullscreenCopyOnSelect` to disable automatic fullscreen selection copy; when disabled, `Ctrl+X` copies the active text selection before falling back to the last assistant message, while `/tree` still copies the selected message ([#7720](https://github.com/earendil-works/pi/issues/7720)).

### Changed

- Changed fullscreen scrollbars to reveal on pointer entry, support optional `scrollbarTrack` and `scrollbarThumb` theme colors with muted and text fallbacks, keep one thumb color across normal and expanded states, and support track-click jumping.
- Changed fullscreen transcript search arrows to underline on hover and capitalized the search placeholder.
- Changed selectors in `/thinking`, `/model`, `/scoped-models`, `/trust`, per-model thinking settings, and theme settings to keep active options marked while browsing. `/scoped-models` now uses consistent per-item toggles and strikes through unavailable models ([#8900](https://github.com/earendil-works/pi/pull/8900)).

### Fixed

- Fixed toggling thinking visibility clearing partial output from running Bash tools ([#8611](https://github.com/earendil-works/pi/issues/8611)).
- Fixed Windows shell aborts crashing Pi when `taskkill.exe` is unavailable on `PATH` ([#6596](https://github.com/earendil-works/pi/issues/6596)).
- Fixed resumed sessions corrupting the next appended entry when their JSONL file lacks a trailing newline ([#8345](https://github.com/earendil-works/pi/issues/8345)).
- Fixed extension messages sent with `triggerTurn: false` while the agent is running being inserted between a tool call and its result, which made providers that validate message order reject the replayed history. They are now appended once the turn's tool results are in ([#8537](https://github.com/earendil-works/pi/issues/8537)).
- Fixed compaction and branch summaries forcing `toolChoice: "none"` ([#8649](https://github.com/earendil-works/pi/issues/8649), [#8638](https://github.com/earendil-works/pi/issues/8638)).
- Fixed large tool results crossing the auto-compaction threshold being sent to the provider before compaction. Pi now compacts between tool execution and the next assistant response in the same run, and restores interactive progress when that run resumes ([#6879](https://github.com/earendil-works/pi/issues/6879)).
- Fixed Google Vertex requests failing with `HttpsProxyAgent is not a constructor` when the bundled Node.js runtime uses an HTTP(S) proxy ([#8610](https://github.com/earendil-works/pi/issues/8610)).
- Fixed saving a default model from a non-empty model scope so it remains available in that scope.
- Fixed inherited `@` file autocomplete ranking to prefer direct and shallower matches over similarly ranked nested paths ([#8669](https://github.com/earendil-works/pi/pull/8669)).
- Fixed inherited OpenAI-compatible streams serializing thinking signatures repeatedly during streaming ([#8671](https://github.com/earendil-works/pi/pull/8671)).
- Fixed inherited main-screen rendering crashing when image-heavy output exceeded V8's string length limit ([#8028](https://github.com/earendil-works/pi/issues/8028)).
- Fixed inherited fullscreen double-click word selection splitting paths and kebab-case tokens on `/` and `-` ([#8676](https://github.com/earendil-works/pi/pull/8676)).
- Fixed inherited Cloudflare AI Gateway catalogs omitting supported `workers-ai/*` passthrough models.
- Fixed inherited OpenAI-compatible reasoning replay to merge consecutive streamed text and summary `reasoning_details` deltas.
- Fixed inherited OpenRouter reasoning controls so reasoning-mandatory models do not receive `effort: "none"` ([#8614](https://github.com/earendil-works/pi/pull/8614) by [@davidbrai](https://github.com/davidbrai)).
- Fixed inherited OpenAI-compatible Chat Completions ignoring an explicitly requested `toolChoice` when no tools are defined.
- Fixed inherited fragmented Mistral tool calls splitting when continuation chunks omit the tool-call ID ([#8387](https://github.com/earendil-works/pi/issues/8387)).

## 0.84.3

### New Features

- **PowerShell tool** — Use optional native PowerShell command execution on Windows. See [PowerShell Tool](docs/windows.md#powershell-tool).
- **Safer managed updates** — Stage, verify, and atomically activate updates for installer-managed installations. See [Install and Manage](docs/packages.md#install-and-manage).
- **Model and thinking controls** — Select thinking levels with `/thinking`, search defaults, keep selections session-scoped, and persist them explicitly with Ctrl+S. See [Models and Thinking](docs/keybindings.md#models-and-thinking).

### Breaking Changes

- Renamed the inherited `GoogleThinkingLevel` type to `GoogleApiThinkingLevel` and added `ResolvedGoogleThinkingLevel` for normalized adapter levels.

### Added

- Added an optional `powershell` tool for Windows, configurable through `defaultTools` and the SDK. See [PowerShell Tool](docs/windows.md#powershell-tool).
- Added a `/thinking` selector and searchable default choices to the model and thinking selectors; Ctrl+S saves the selected model as the global default. See [Models and Thinking](docs/keybindings.md#models-and-thinking).
- Added optional routing session IDs to exported compaction summary helpers so callers can preserve provider routing without enabling prompt cache writes.
- Added transcript usage notices for compaction and branch summaries when cache miss notices are enabled.
- Added `session_compact_failed` extension events so compaction failures and aborts expose their reason, retry state, source, and error message to handlers ([#8175](https://github.com/earendil-works/pi/issues/8175)).
- Added inherited provider-neutral `toolChoice` support to simple stream requests.
- Added inherited automatic Anthropic server-side refusal fallback for supported first-party models, including returned-model usage pricing ([#8017](https://github.com/earendil-works/pi/issues/8017)).
- Added inherited configurable OpenAI-compatible thinking-token budget fields for vLLM, Qwen/SGLang, and llama.cpp servers. See [OpenAI Compatibility](docs/models.md#openai-compatibility) ([#8275](https://github.com/earendil-works/pi/pull/8275) by [@bnsd55](https://github.com/bnsd55)).
- Added inherited China-specific ZAI Coding Plan models, including GLM-4.6V vision support and API-equivalent usage cost estimates ([#8220](https://github.com/earendil-works/pi/issues/8220)).
- Added inherited `deepseek-v4-pro-0813` support to the Qwen Token Plan Individual catalog ([#8194](https://github.com/earendil-works/pi/issues/8194)).

### Changed

- Changed experimental installer-managed installations so `pi update` stages, verifies, and atomically activates the selected release in place. See [Install and Manage](docs/packages.md#install-and-manage).
- Changed inherited built-in xAI models to use the Responses API with encrypted reasoning replay and made Grok 4.6 the default xAI model ([#8124](https://github.com/earendil-works/pi/pull/8124) by [@Jaaneek](https://github.com/Jaaneek)).
- Changed inherited Anthropic, Azure OpenAI, Google, Mistral, and OpenAI adapters to send Pi's default `User-Agent` unless overridden ([#8305](https://github.com/earendil-works/pi/issues/8305)).
- Changed Windows and WSL keybinding defaults to avoid terminal-reserved shortcuts for image paste, model cycling, editor undo, fullscreen transcript navigation and search, and message queueing ([#8372](https://github.com/earendil-works/pi/issues/8372)).
- Changed Bun release archives to ship the native clipboard binary only inside the wrapper package, removing a duplicate platform package from each archive.
- Changed package resource glob expansion to use Node.js's built-in implementation with deterministic visible-path matching, reducing the installed runtime dependency tree.
- Changed the bundled Node.js runtime to load jiti only when importing an extension and Babel only when uncached source needs transformation, reducing CLI startup time and bundle size.
- Changed syntax highlighting to initialize only twenty common languages eagerly and defer the remaining grammars until after the initial TUI render, reducing CLI startup time.
- Changed the Node.js CLI and RPC entrypoints to load a bundled runtime, reducing startup filesystem reads while keeping the public library and legacy module paths on the modular runtime for normal dependency identity.
- Changed session sharing to render clickable terminal links, display only the canonical Radius artifact URL, and include the current system prompt and active tool definitions in Radius session shares.

### Fixed

- Fixed failed extension factories leaving event subscriptions, provider registrations, and default flag state active ([#8424](https://github.com/earendil-works/pi/pull/8424) by [@acmerfight](https://github.com/acmerfight)).
- Fixed `models.json` typings omitting the documented OpenAI-compatible `compat.supportsFinishReason` provider and model override ([#8487](https://github.com/earendil-works/pi/pull/8487) by [@petrroll](https://github.com/petrroll)).
- Fixed `/model` and `/thinking` selections being persisted globally unless explicitly saved with Ctrl+S ([#5263](https://github.com/earendil-works/pi/issues/5263)).
- Fixed JSON and RPC `toolcall_start` events omitting the tool call id and name ([#7953](https://github.com/earendil-works/pi/pull/7953) by [@christianklotz](https://github.com/christianklotz)).
- Fixed extensions failing to load when the Node.js CLI runs as a single-executable application ([#8237](https://github.com/earendil-works/pi/issues/8237)).
- Fixed nested Markdown skills inside `.agents/skills/` grouping directories not being discovered.
- Fixed compaction and branch summarization requests exposing tools to providers.
- Fixed single-object `edit` tool inputs failing validation by accepting them as one-edit arrays in both coding-agent and harness edit tools ([#7835](https://github.com/earendil-works/pi/issues/7835)).
- Fixed root Markdown files such as `README.md` and `AGENTS.md` in skill directories being reported as broken skills unless they declare valid skill frontmatter ([#7805](https://github.com/earendil-works/pi/issues/7805)).
- Fixed the default Cerebras model referencing an unavailable Z.AI model.
- Fixed inherited OpenAI-compatible Chat Completions reasoning replay to preserve and resend assistant-level `reasoning_details` verbatim and in order ([#7994](https://github.com/earendil-works/pi/issues/7994)).
- Fixed inherited Anthropic server-side fallback responses being priced with the requested model instead of the returned fallback model ([#8285](https://github.com/earendil-works/pi/issues/8285)).
- Fixed inherited GitHub Copilot login triggering model-policy rate limits by limiting policy updates, retrying model discovery once, and honoring server retry delays ([#7850](https://github.com/earendil-works/pi/issues/7850)).
- Fixed inherited Amazon Bedrock dropping and failing to replay opaque redacted reasoning from non-Anthropic models ([#8314](https://github.com/earendil-works/pi/pull/8314) by [@seiji](https://github.com/seiji)).
- Fixed inherited Z.AI Coding Plan models deriving incomplete reasoning-effort metadata, including missing GLM-5.3 low, high, and max levels ([#8336](https://github.com/earendil-works/pi/issues/8336)).
- Fixed inherited DeepSeek V4 Flash on OpenCode and OpenCode Go omitting its supported low thinking level ([#8181](https://github.com/earendil-works/pi/pull/8181) by [@tianshuang](https://github.com/tianshuang)).
- Fixed inherited Azure OpenAI Responses ignoring `toolChoice` in provider-specific stream requests.
- Fixed inherited Amazon Bedrock response hooks receiving only a synthesized request id instead of the raw response headers ([#8234](https://github.com/earendil-works/pi/issues/8234)).
- Fixed inherited Kimi usage reporting so top-level `cached_tokens` count as cache reads instead of normal input tokens ([#8075](https://github.com/earendil-works/pi/issues/8075)).
- Fixed inherited Google custom models ignoring `thinkingLevelMap`, which dropped extended thinking controls ([#8135](https://github.com/earendil-works/pi/issues/8135)).
- Fixed writes to `auth.json` and `models-store.json` overriding administrator-managed file permissions and ACLs ([#7779](https://github.com/earendil-works/pi/issues/7779)).
- Fixed UTF-8 BOM markers preventing frontmatter and user configuration files from loading ([#8337](https://github.com/earendil-works/pi/issues/8337)).
- Fixed invalid settings files being easy to miss during interactive startup by rendering warnings with the file path inside the TUI ([#7829](https://github.com/earendil-works/pi/issues/7829)).
- Fixed the subagent example repeatedly prompting before running project-local agents in trusted repositories ([#8261](https://github.com/earendil-works/pi/issues/8261)).
- Added `session_compact_failed` extension events so compaction failures and aborts expose their reason, retry state, source, and error message to handlers ([#8175](https://github.com/earendil-works/pi/issues/8175)).
- Fixed truncated compaction and branch summaries being persisted when generation reaches its output token limit ([#7048](https://github.com/earendil-works/pi/issues/7048)).
- Fixed npm package update checks treating older registry versions as available updates, preventing `pi update` from downgrading already-newer installed packages ([#8226](https://github.com/earendil-works/pi/issues/8226)).
- Fixed built-in llama.cpp models disappearing from `/model` when `/llama` refreshed a configured server under `PI_OFFLINE`, and included idle-slept `sleeping` router models plus autoloadable unloaded presets in the selectable catalog ([#8558](https://github.com/earendil-works/pi/pull/8558) by [@cristinaponcela](https://github.com/cristinaponcela)).
- Fixed `pi.registerFlag()` accepting default values that do not match the declared flag type ([#8064](https://github.com/earendil-works/pi/issues/8064)).
- Fixed Z.AI Coding Plan defaults referencing the removed GLM-5.1 model ([#8096](https://github.com/earendil-works/pi/issues/8096)).
- Fixed repeated ambiguous truncated-response recovery being mislabeled as context overflow ([#8130](https://github.com/earendil-works/pi/issues/8130)).
- Fixed duplicate fullscreen right-click paste in VS Code-based terminals on Windows ([#8186](https://github.com/earendil-works/pi/issues/8186)).
- Fixed inherited padded text exceeding narrow terminal widths ([#8252](https://github.com/earendil-works/pi/issues/8252)).
- Fixed inherited wrapped Markdown table links leaking color into borders and neighboring cells, including tables inside blockquotes ([#8335](https://github.com/earendil-works/pi/issues/8335)).
- Fixed llama.cpp login guidance to direct users to `/llama` before `/model` when no local models are loaded ([#8203](https://github.com/earendil-works/pi/issues/8203)).
- Fixed hung pi.dev model catalog requests consuming the entire refresh deadline without retrying ([#8198](https://github.com/earendil-works/pi/issues/8198)).
- Fixed inherited Xiaomi model catalogs listing shut-down MiMo V2 models in `/model` and `--list-models` ([#8187](https://github.com/earendil-works/pi/issues/8187)).
- Fixed branch summary entries recording the navigation destination in `fromId` instead of the pre-navigation source leaf.
- Fixed threshold auto-compaction being skipped when providers omit streaming usage data ([#8328](https://github.com/earendil-works/pi/issues/8328)).
- Fixed dash-prefixed prompts being parsed as options by supporting `--` as an end-of-options delimiter ([#7269](https://github.com/earendil-works/pi/issues/7269)).

## 0.84.2

### New Features

- **Fullscreen transcript search** — Search and navigate matches in fullscreen mode. See [TUI Fullscreen Viewport](docs/keybindings.md#tui-fullscreen-viewport).
- **Configurable default tools** — Choose startup built-in tools globally or per project. See [Tools](docs/settings.md#tools).
- **Configurable fullscreen exit output** — Print the transcript or only a resume hint on exit. See [Interactive Mode](docs/usage.md#interactive-mode).

### Added

- Added per-block fullscreen mouse expansion for thinking sections and tool results, while preserving drag selection and link activation.
- Added fullscreen transcript search with `Ctrl+Shift+F`, incremental match highlighting, configurable search match theme colors, and next/previous navigation with `Enter`/`Ctrl+G` and `Shift+Enter`/`Ctrl+Shift+G`.
- Added experimental strict JSON-schema constrained sampling for the default `read`, `bash`, `edit`, and `write` tools under `PI_EXPERIMENTAL=1`.
- Added a fullscreen exit output setting to choose between printing the final transcript and only a session resume hint.
- Added the `defaultTools` setting for configuring the initial built-in tool selection globally or per project.
- Added `--use-theme <name[/name]>` to choose an initial per-run interactive theme without changing saved settings ([#7722](https://github.com/earendil-works/pi/pull/7722) by [@rwachtler](https://github.com/rwachtler)).
- Added `expandPromptTemplates` to extension `pi.sendUserMessage()` options for explicitly dispatching commands and expanding skills and prompt templates. See [`pi.sendUserMessage()`](docs/extensions.md#pisendusermessagecontent-options) ([#7857](https://github.com/earendil-works/pi/pull/7857) by [@mrexodia](https://github.com/mrexodia)).
- Added inherited `createGatewayBindingFetch()` for routing Cloudflare AI Gateway requests through a Workers AI binding without an API token ([#7901](https://github.com/earendil-works/pi/pull/7901) by [@Maximo-Guk](https://github.com/Maximo-Guk)).
- Added inherited `AssistantMessage.endTurn` to preserve OpenAI Codex's terminal `end_turn` signal for diagnostics ([#7766](https://github.com/earendil-works/pi/pull/7766)).
- Added inherited unbound single-line transcript scrolling actions for fullscreen mode. See [TUI Fullscreen Viewport](docs/keybindings.md#tui-fullscreen-viewport) ([#7903](https://github.com/earendil-works/pi/pull/7903) by [@midastruth](https://github.com/midastruth)).

### Changed

- Changed inherited Kimi Coding requests to use pi's runtime `User-Agent` header.
- Replaced the inherited Mistral SDK transport with a native Chat Completions HTTP stream, eliminating its generated client and schema runtime overhead.
- Documented the generic `AI_AGENT=pi` process marker and how it differs from `PI_CODING_AGENT=true` ([#7747](https://github.com/earendil-works/pi/issues/7747)).
- Changed inherited OpenAI Responses deferred tool loading to prefer message-anchored `additional_tools` where supported while retaining tool-search and top-level fallbacks ([#7709](https://github.com/earendil-works/pi/issues/7709)).
- Reduced inherited fullscreen rendering allocation churn by painting full-width layout rows directly instead of recompositing them on every frame.

### Fixed

- Fixed root Markdown files such as `README.md` and `AGENTS.md` in skill directories being reported as broken skills unless they declare valid skill frontmatter ([#7805](https://github.com/earendil-works/pi/issues/7805)).
- Fixed single-object `edit` tool inputs failing validation by accepting them as one-edit arrays in both coding-agent and harness edit tools ([#7835](https://github.com/earendil-works/pi/issues/7835)).
- Fixed managed-tool downloads delaying TUI startup and hiding diagnostics in fullscreen mode by mounting the TUI first and showing download progress and warnings inside it.
- Fixed opening a model selector immediately after startup cancelling and restarting the in-progress model catalog refresh.
- Fixed inherited GitHub Copilot login triggering API rate limits while enabling model policies by limiting concurrent policy updates ([#6187](https://github.com/earendil-works/pi/issues/6187)).
- Fixed fullscreen transcript search snapping back to the current match during manual scrolling and fragmented mouse input leaking into the search query.
- Fixed inherited required LaTeX arguments starting on a new line being parsed as empty ([#7760](https://github.com/earendil-works/pi/issues/7760)).
- Updated the transitive `nanoid` development dependency to address a denial-of-service vulnerability.
- Fixed fallback rendering for extension tool results to collapse long output and honor tool expansion ([#7979](https://github.com/earendil-works/pi/issues/7979)).
- Fixed JSON and RPC `message_update` events dropping cumulative usage during streaming. See [JSON Event Mode](docs/json.md) and [RPC `message_update`](docs/rpc.md#message_update-streaming) ([#7982](https://github.com/earendil-works/pi/pull/7982) by [@christianklotz](https://github.com/christianklotz)).
- Fixed `pi.sendMessage(..., { triggerTurn: false })` steering an active run instead of only recording the custom message ([#8022](https://github.com/earendil-works/pi/pull/8022) by [@cristinaponcela](https://github.com/cristinaponcela)).
- Fixed the `defaultTools` setting dropping extension and SDK custom tools when selecting built-in defaults.
- Fixed the subagent example rejecting YAML array syntax for the `tools` frontmatter field ([#7598](https://github.com/earendil-works/pi/pull/7598) by [@alexsavio](https://github.com/alexsavio)).
- Fixed the subagent example dropping parent session model, thinking, and tool configuration ([#7897](https://github.com/earendil-works/pi/pull/7897) by [@virtuald](https://github.com/virtuald)).
- Fixed custom system prompts concatenating the current working directory with later appended prompt content ([#7887](https://github.com/earendil-works/pi/pull/7887) by [@distributedlock](https://github.com/distributedlock)).
- Fixed inherited OpenAI Responses function and custom tool calls losing namespaces during streaming, proxying, and replay ([#7709](https://github.com/earendil-works/pi/issues/7709)).
- Fixed inherited upstream request buffer failures not triggering automatic assistant retries.
- Fixed inherited built-in and custom DeepSeek API models sending output limits through an unsupported field.
- Fixed inherited Amazon Bedrock replay rejecting tool arguments that contain empty object keys while preserving all valid nested values ([#7882](https://github.com/earendil-works/pi/pull/7882) by [@muyiyr](https://github.com/muyiyr)).
- Fixed inherited DeepSeek compatibility detection for base URLs whose hostname contains uppercase letters ([#7933](https://github.com/earendil-works/pi/pull/7933) by [@yearth](https://github.com/yearth)).
- Fixed inherited Google Generative AI and Vertex AI responses with tool calls incorrectly treating output-limit or provider-error stops as normal tool use ([#8059](https://github.com/earendil-works/pi/issues/8059)).
- Fixed inherited fullscreen mouse drag selection and OSC 8 link activation in terminals that report generic SGR mouse release button codes ([#7963](https://github.com/earendil-works/pi/issues/7963)).
- Fixed inherited focused fullscreen overlays not receiving mouse wheel or viewport scroll keys such as PageUp and PageDown ([#7894](https://github.com/earendil-works/pi/issues/7894)).
- Fixed inherited LaTeX control spaces split across line endings causing complete expressions to fall back to raw source.
- Fixed split `Alt+Enter` input over SSH being misread as Escape, added `PI_TUI_ESC_TIMEOUT` for high-latency terminals, and limited that timeout to lone Escape input ([#7899](https://github.com/earendil-works/pi/pull/7899) by [@powerfooI](https://github.com/powerfooI)).
- Fixed inherited idle fullscreen sessions repainting and clearing text selection when the terminal loses focus ([#7892](https://github.com/earendil-works/pi/pull/7892) by [@terrorobe](https://github.com/terrorobe)).
- Fixed fullscreen selection copy to use the host clipboard and report failure instead of claiming success when OSC 52 is unsupported ([#8110](https://github.com/earendil-works/pi/pull/8110) by [@Panoplos](https://github.com/Panoplos)).

## 0.84.1

### New Features

- **Qwen Token Plan Individual** — Use the built-in provider for models documented for Individual subscriptions. See [API Keys](docs/providers.md#api-keys).
- **Authentication readiness checks** — Use `pi auth check` to verify provider or model credentials, optionally emitting the resolved credential.
- **Improved fullscreen interaction** — Select words and paragraphs with multiple clicks and configure half-page transcript scrolling. See [TUI Fullscreen Viewport](docs/keybindings.md#tui-fullscreen-viewport).
- **Terminating blocked tool calls** — Extension `tool_call` handlers can stop all-terminating batches without another model call. See [Tool Events](docs/extensions.md#tool-events).

### Added

- Added Qwen Token Plan Individual as a built-in provider with its documented subscription model catalog and the shared international `QWEN_TOKEN_PLAN_API_KEY`. See [API Keys](docs/providers.md#api-keys) ([#7659](https://github.com/earendil-works/pi/pull/7659) by [@arasovic](https://github.com/arasovic)).
- Added `pi auth check` provider/model auth preflight with optional credential output ([#7152](https://github.com/earendil-works/pi/issues/7152)).
- Added `terminate` support to blocked extension `tool_call` events so all-terminating batches can skip the automatic follow-up model call. See [Tool Events](docs/extensions.md#tool-events) ([#7715](https://github.com/earendil-works/pi/pull/7715) by [@muyiyr](https://github.com/muyiyr)).
- Added inherited double-click word and whitespace selection, granularity-aware drag selection, and triple-click paragraph selection in fullscreen mode ([#7725](https://github.com/earendil-works/pi/issues/7725), [#7733](https://github.com/earendil-works/pi/pull/7733) by [@volsa](https://github.com/volsa)).
- Added inherited unbound half-page transcript scrolling actions for fullscreen mode. See [TUI Fullscreen Viewport](docs/keybindings.md#tui-fullscreen-viewport) ([#7735](https://github.com/earendil-works/pi/issues/7735)).

### Changed

- Softened the bash tool's `PI_*` environment guideline in an attempt to reduce unnecessary inspection commands ([#7128](https://github.com/earendil-works/pi/issues/7128)).
- Reduced worst-case automatic terminal theme detection delay from 200 ms to 100 ms by probing color-scheme and background support concurrently.

### Fixed

- Fixed Bun standalone binaries crashing on startup when the cwd contains a `bunfig.toml` with `preload` by compiling with `--no-compile-autoload-bunfig` ([#7685](https://github.com/earendil-works/pi/pull/7685) by [@geril07](https://github.com/geril07)).
- Fixed extension TUI method wrappers recursing indefinitely when delegating to the original method ([#7731](https://github.com/earendil-works/pi/issues/7731)).
- Fixed right-click not pasting clipboard text in fullscreen mode on Windows.
- Fixed inherited `Agent.reset()` clearing transcript and runtime state during active runs; it now rejects until the agent is idle ([#7717](https://github.com/earendil-works/pi/pull/7717) by [@wesleyzhangwq](https://github.com/wesleyzhangwq)).
- Fixed inherited LaTeX relation, multiplication, and named-operator spacing, and matrix composition with stacked fractions, operator limits, and adjacent matrices.
- Reduced inherited fullscreen mouse event volume under tmux, Zellij, and GNU Screen by using button-motion tracking instead of all-motion tracking.
