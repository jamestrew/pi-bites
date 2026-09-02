# Pi upstream watch — 2026-09-02

Package: `@earendil-works/pi-coding-agent`
Checkpoint: `0.84.0`
Latest upstream: `0.84.4`

## Agent review checklist

Classify every entry below as `adapt`, `leverage`, `watch`, or `irrelevant`. Cross-reference local extension code before recommending action. Do not update `docs/upstream-watch/state.json` until the review is accepted.

Local surfaces to check first: `packages/ext/index.ts`, `packages/ext/config.ts`, `packages/ext/tools.ts`, `packages/ext/explore/`, `packages/ext/statusline.ts`, `packages/ext/notifications.ts`, `packages/ext/file-search/`, `packages/ext/inline-references/`, and docs under `README.md`.

## Upstream entries

## 0.84.4

### New Features

- **Terminal capability overrides** — Override detected terminal hyperlink, image, and truecolor support. See [Capability Overrides](docs/terminal-setup.md#capability-overrides).
- **Extension UI prompt events** — Integrations can distinguish active agent work from time spent waiting for `ctx.ui` prompts. See [Extension UI prompt events](docs/extensions.md#ui_prompt_start--ui_prompt_end).
- **RPC queue clearing** — Retrieve and clear queued steering and follow-up messages with `clear_queue`. See [RPC `clear_queue`](docs/rpc.md#clear_queue).
- **Fullscreen selection copy controls** — Disable automatic selection copying in fullscreen mode and use Ctrl+X to copy the active selection. See [UI & Display](docs/settings.md#ui--display).
- **DeepSeek V4 Flash Vision (experimental)** — Use the vision-capable model through the built-in DeepSeek provider. See [API Keys](docs/providers.md#api-keys).

### Added

- Added `ui_prompt_start` and `ui_prompt_end` extension events so host integrations can distinguish active agent work from waiting on user-facing `ctx.ui` prompts ([#8355](https://github.com/earendil-works/pi/pull/8355) by [@cristinaponcela](https://github.com/cristinaponcela)).
- Added `detectSupportedImageMimeTypeFromFile()` to the public library exports ([#8600](https://github.com/earendil-works/pi/pull/8600) by [@xl0](https://github.com/xl0)).
- Added inherited experimental vision-capable `deepseek-v4-flash-vision-exp` model support.
- Added transcript usage notices for compaction and branch summaries when cache miss notices are enabled.
- Added RPC `clear_queue` to retrieve and remove queued steering and follow-up messages ([#8432](https://github.com/earendil-works/pi/issues/8432)).
- Added environment variables and advanced settings for overriding auto-detected terminal hyperlink, image, and truecolor capabilities ([#8665](https://github.com/earendil-works/pi/issues/8665)).
- Added `fullscreenCopyOnSelect` to disable automatic fullscreen selection copy; when disabled, `Ctrl+X` copies the active text selection before falling back to the last assistant message, while `/tree` still copies the selected message ([#7720](https://github.com/earendil-works/pi/issues/7720)).

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
- Added

usage notices for compaction and branch summaries when cache miss notices are enabled.

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
