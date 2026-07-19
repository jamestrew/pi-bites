# Pi upstream watch — 2026-07-19

Package: `@earendil-works/pi-coding-agent`
Checkpoint: `0.80.3`
Latest upstream: `0.80.10`

## Agent review checklist

Classify every entry below as `adapt`, `leverage`, `watch`, or `irrelevant`. Cross-reference local extension code before recommending action. Do not update `docs/upstream-watch/state.json` until the review is accepted.

Local surfaces to check first: `packages/ext/index.ts`, `packages/ext/config.ts`, `packages/ext/tools.ts`, `packages/ext/explore/`, `packages/ext/statusline.ts`, `packages/ext/notifications.ts`, `packages/ext/file-search/`, `packages/ext/inline-references/`, and docs under `README.md`.

## Upstream entries

## 0.80.10

### New Features

- **Kimi Coding thinking compatibility** — Kimi Coding models now use adaptive thinking correctly; K3 exposes its supported `max` level and supports replaying empty-signature thinking blocks. See [Kimi For Coding setup](docs/providers.md#api-keys) and [Model Options](docs/usage.md#model-options).

### Fixed

- Fixed inherited Kimi Coding requests to use Anthropic adaptive thinking effort without token budgets, and enabled empty thinking signatures for K3 and `kimi-for-coding`.
- Fixed inherited Kimi K3 pricing metadata for Moonshot AI and Moonshot AI China.
- Fixed inherited Kimi Coding K3 thinking-level metadata to expose only the supported `max` level ([#6737](https://github.com/earendil-works/pi/issues/6737)).
- Fixed inherited catalog generation restoring xAI models removed in 0.80.9 ([#6736](https://github.com/earendil-works/pi/issues/6736)).

## 0.80.9

### New Features

- **Kimi K3 and deferred tool loading** — Use Kimi K3 across built-in providers, including progressive extension tool activation through Kimi’s native protocol. See [Dynamic Tool Loading](docs/extensions.md#dynamic-tool-loading), [OpenAI Compatibility](docs/models.md#openai-compatibility), and the [`kimi-deferred-tools.ts`](examples/extensions/kimi-deferred-tools.ts) example.

### Added

- Added inherited Kimi K3 support for Kimi Coding, Moonshot AI, Moonshot AI China, OpenRouter, and Vercel AI Gateway.
- Added Kimi deferred tool loading for extension-driven tool activation. See [Dynamic Tool Loading](docs/extensions.md#dynamic-tool-loading), [OpenAI Compatibility](docs/models.md#openai-compatibility), and the [`kimi-deferred-tools.ts`](examples/extensions/kimi-deferred-tools.ts) example.

### Changed

- Changed xAI login to use a prefilled device-authorization link labeled “Sign in with SuperGrok or X Premium,” and changed the default xAI model to Grok 4.5 ([#6734](https://github.com/earendil-works/pi-mono/pull/6734) by [@Jaaneek](https://github.com/Jaaneek)).

### Fixed

- Fixed inherited Kimi K3 output limits for Vercel AI Gateway and OpenRouter models.
- Fixed cloning or forking a session before its first assistant response to explain that the session must be saved first.

### Removed

- Removed Grok 3, Grok 3 Fast, Grok 4.20 variants, and Grok Code Fast 1 from the built-in xAI model catalog ([#6734](https://github.com/earendil-works/pi-mono/pull/6734) by [@Jaaneek](https://github.com/Jaaneek)).

## 0.80.8

### New Features

- **Unified model runtime and provider authentication** — `ModelRuntime` centralizes model configuration, provider-owned `/login`, and dynamic provider catalogs. See [Providers](docs/providers.md).
- **Live model catalog refresh** — `/model` refreshes configured providers in the background, and `pi update --models` forces an immediate refresh. See [Install and Manage](docs/packages.md#install-and-manage).
- **xAI device-code OAuth and Grok 4.5 Responses support** — Sign in to xAI with a device code and use Grok 4.5 with low, medium, or high thinking. See [xAI](docs/providers.md#xai-grokx-subscription).

### Breaking Changes

- Replaced the SDK's `CreateAgentSessionOptions.authStorage` and `modelRegistry` options with the async `modelRuntime` option. `AuthStorage` and its storage backends are no longer exported; use `ModelRuntime` (or a custom pi-ai `CredentialStore`), or `readStoredCredential()` for one-off reads of auth.json.
- Removed redundant `ModelRuntime.getAll()`, `find()`, `getSnapshot()`, and `getAuthOptions()` projections. Use the pi-ai `Models` methods `getModels()`, `getModel()`, `getProviders()`, and `checkAuth()` directly.
- Replaced SDK request-auth assembly through `ModelRegistry.getApiKeyAndHeaders()` with `ModelRuntime.getAuth()`. Passing a provider ID returns provider-scoped auth; passing a model also resolves built-in, `models.json`, and extension model headers.
- Changed extension-facing `ModelRegistry.refresh()` from synchronous `void` to `Promise<void>` because `models.json` loading is asynchronous. Extensions must await it before making synchronous registry reads.
- Moved canonical dynamic catalog refresh to async `ModelRuntime.refresh()`/pi-ai `Models.refresh()`. Legacy extension OAuth `modifyModels` remains supported as a synchronous compatibility projection after credential initialization.

### Added

- Added `ModelRuntime` as the canonical async SDK and internal model/auth facade while preserving the synchronous extension-facing `ModelRegistry` API. `ModelRuntime.create()` accepts any pi-ai `CredentialStore` through its `credentials` option.
- Added provider-owned `/login` discovery directly from registered pi-ai providers, including ambient auth status and informational links.
- Added file-backed dynamic catalogs in `models-store.json`, per-provider pi.dev catalog overlays, and Radius gateway support including offline migration from legacy credential-cached catalogs.
- Added extension provider `refreshModels(context)` support for dynamic model discovery with optional provider-controlled persistence.
- Added `pi update --models` to force an immediate model catalog refresh without updating pi or extensions.
- Added inherited xAI device-code OAuth login and Grok 4.5 OpenAI Responses support, with low, medium, and high thinking levels ([#6651](https://github.com/earendil-works/pi-mono/pull/6651) by [@Jaaneek](https://github.com/Jaaneek)).

### Changed

- Changed `ModelRuntime` to compose built-in providers, immutable `models.json` configuration, and extension overlays through ad-hoc pi-ai provider methods.
- Changed `ModelRuntime` to own final request assembly: `getAuth(model)` includes configured model headers, stream methods resolve auth once, and `before_provider_headers` runs as the Models-only header transform before provider dispatch.
- Changed `/model` to render the current model snapshot immediately, refresh configured providers in the background, and update the open selector with partial results or timeout errors.

### Fixed

- Fixed configured-provider catalog refresh to parse pi.dev's model-ID keyed responses, throttle checks to once per four hours, send the versioned pi user agent, treat unimplemented routes as unavailable overlays, and show concise refresh status in `/model`.
- Fixed adjacent assistant thinking blocks to render as one thinking section.
- Fixed inherited OpenAI Codex session IDs longer than 64 characters to meet the API limit ([#6630](https://github.com/earendil-works/pi-mono/issues/6630)).
- Fixed inherited terminal output to normalize tab characters consistently ([#6697](https://github.com/earendil-works/pi-mono/pull/6697) by [@xz-dev](https://github.com/xz-dev)).
- Fixed the Windows terminal title after checking npm packages ([#6629](https://github.com/earendil-works/pi-mono/issues/6629)).
- Fixed Bun standalone binaries to bundle OAuth adapters for interactive logins.

## 0.80.7

### Breaking Changes

- Removed the `openai-responses` `compat.sendSessionIdHeader` flag from `models.json`. Session-affinity behavior is now controlled by `compat.sessionAffinityFormat` (`"openai"`, `"openai-nosession"`, or `"openrouter"`). Replace `sendSessionIdHeader: false` with `sessionAffinityFormat: "openai-nosession"` ([#6496](https://github.com/earendil-works/pi-mono/pull/6496) by [@petrroll](https://github.com/petrroll)).

### New Features

- **Cache-friendly dynamic tool loading** - Extensions can add tools during execution while supported Anthropic and OpenAI Responses models preserve prompt-cache prefixes. See [Dynamic Tool Loading](docs/extensions.md#dynamic-tool-loading).
- **Message copy shortcut** - `Ctrl+X` copies the last assistant message in the transcript or the selected message in `/tree`, making older and branched messages directly copyable. See [Display and Message Queue](docs/keybindings.md#display-and-message-queue).
- **Fable 5 `xhigh` and `max` thinking** - Native `xhigh` and `max` thinking levels are available across generated provider catalogs. See [Model Options](docs/usage.md#model-options).

### Added

- Added cache-friendly dynamic tool loading for extension tools activated by tool results. Supported Anthropic and OpenAI Responses models load definitions where they become available, preserving the cached prompt prefix. See [Dynamic Tool Loading](docs/extensions.md#dynamic-tool-loading) ([#6474](https://github.com/earendil-works/pi-mono/pull/6474)).
- Added inherited native `xhigh` and `max` thinking levels for Claude Fable 5 across all generated provider catalogs ([#6490](https://github.com/earendil-works/pi-mono/pull/6490) by [@davidbrai](https://github.com/davidbrai)).
- Added `Ctrl+X` to copy the last assistant message, or the selected message in `/tree`.
- Added inherited `toolChoice` support for OpenAI and Codex Responses, including required and named tool selection ([#6588](https://github.com/earendil-works/pi-mono/pull/6588) by [@xl0](https://github.com/xl0)).

### Fixed

- Fixed inherited OpenRouter model context windows to use the top provider's actual context length ([#6481](https://github.com/earendil-works/pi-mono/pull/6481) by [@davidbrai](https://github.com/davidbrai)).
- Fixed inherited OpenRouter OpenAI-compatible session IDs to use the `x-session-id` header instead of OpenAI-specific session-affinity fields ([#6496](https://github.com/earendil-works/pi-mono/pull/6496) by [@petrroll](https://github.com/petrroll)).
- Fixed `Ctrl+V` to paste clipboard text when the pasteboard does not contain an image.
- Fixed `/login amazon-bedrock` to prompt for and save a Bedrock API key instead of only displaying ambient AWS credential setup instructions.
- Fixed inherited Amazon Bedrock ambient AWS credentials to keep using SigV4 authentication, including for custom model IDs ([#6532](https://github.com/earendil-works/pi-mono/pull/6532) by [@ribelo](https://github.com/ribelo)).
- Fixed inherited Cloudflare Workers AI and AI Gateway authentication to use ambient account and gateway IDs when stored credentials contain only an API key ([#6292](https://github.com/earendil-works/pi-mono/pull/6292) by [@markphelps](https://github.com/markphelps)).
- Fixed inherited legacy terminal decoding for Alt+symbol key combinations such as `Alt+,` and `Alt+.` ([#6523](https://github.com/earendil-works/pi-mono/pull/6523) by [@ribelo](https://github.com/ribelo)).
- Fixed the GitHub Copilot `mai-code-1-flash-picker` model to route through the `/responses` endpoint ([#6544](https://github.com/earendil-works/pi-mono/pull/6544) by [@petrroll](https://github.com/petrroll)).
- Fixed branch summaries to work with providers that use ambient authentication instead of API keys ([#6595](https://github.com/earendil-works/pi-mono/pull/6595) by [@davidbrai](https://github.com/davidbrai)).
- Fixed inherited Amazon Bedrock errors to report unhandled provider stop reasons instead of only `An unknown error occurred` ([#6598](https://github.com/earendil-works/pi-mono/pull/6598) by [@davidbrai](https://github.com/davidbrai)).
- Fixed npm package removal when installed packages have conflicting peer dependencies ([#6604](https://github.com/earendil-works/pi-mono/pull/6604) by [@davidbrai](https://github.com/davidbrai)).
- Fixed inherited Azure OpenAI Responses reasoning replay when `encrypted_content` appears only in the terminal response event ([#6608](https://github.com/earendil-works/pi-mono/pull/6608) by [@davidbrai](https://github.com/davidbrai)).
- Fixed inherited Anthropic-compatible proxies that omit `usage` from `message_delta` events ([#6611](https://github.com/earendil-works/pi-mono/pull/6611) by [@davidbrai](https://github.com/davidbrai)).
- Fixed inherited OpenCode OpenAI Responses models to omit the unsupported `session-id` header while preserving other cache-affinity data ([#6645](https://github.com/earendil-works/pi-mono/pull/6645) by [@davidbrai](https://github.com/davidbrai)).
- Fixed system prompt cache invalidation across dates by removing the current date from the default prompt ([#6621](https://github.com/earendil-works/pi/issues/6621)).

## 0.80.6

### New Features

- **`max` thinking level** - New opt-in thinking level above `xhigh`, natively supported on GPT-5.6 and adaptive Claude models, available across CLI (`--thinking max`), SDK, RPC, and model selection. Custom themes can define `thinkingMax`. See [CLI Reference](docs/usage.md#cli-reference).
- **Input-based pricing tiers** - Request-wide input-token pricing tiers for accurate long-context cost accounting (e.g. GPT-5.4/5.5/5.6 long-context rates), also configurable for custom models in `models.json` and `modelOverrides`. See [Model Configuration](docs/models.md#model-configuration).

### Added

- Added the opt-in `max` thinking level across CLI, SDK, RPC, model selection, and themes. Custom themes can define `thinkingMax`; existing themes fall back to `thinkingXhigh`.
- Added request-wide input-token pricing tiers to custom model costs in `models.json`, `modelOverrides`, and extension-registered providers.
- Added `~` (home directory) expansion for the `shellPath` setting ([#6470](https://github.com/earendil-works/pi/pull/6470) by [@aaronkyriesenbach](https://github.com/aaronkyriesenbach)).

### Fixed

- Fixed inherited post-compaction output-token budgeting to ignore stale assistant usage from before the compaction boundary ([#6464](https://github.com/earendil-works/pi/issues/6464)).
- Fixed inherited GPT-5.4 and GPT-5.5 long-context cost accounting while retaining the intentional 272K default context limit for models that require an explicit override.
- Fixed inherited GPT-5.6 metadata to keep direct OpenAI requests in the 272K short-context tier while exposing the Codex backend's 372K context window with long-context pricing, and removed the nonexistent bare `gpt-5.6` alias.
- Fixed inherited Anthropic message conversion to preserve thinking blocks with empty thinking text but a valid signature instead of dropping them, avoiding thinking-block errors on newer Claude models ([#6457](https://github.com/earendil-works/pi/pull/6457) by [@davidbrai](https://github.com/davidbrai)).

## 0.80.5

## 0.80.4

### New Features

- **Prompt cache miss visibility** - Significant cache misses can be shown in transcripts via `showCacheMissNotices`. See [Model & Thinking](docs/settings.md#model--thinking).
- **Project-local resource configuration** - `pi config -l` and Tab switching manage global vs project-local package resources. See [Enable and Disable Resources](docs/packages.md#enable-and-disable-resources).
- **Extension lifecycle and provider hooks** - Extensions get `agent_settled`, `before_provider_headers`, entry renderers, and `InlineExtension`. See [agent_start / agent_end / agent_settled](docs/extensions.md#agent_start--agent_end--agent_settled), [before_provider_headers](docs/extensions.md#before_provider_headers), and [InlineExtension](docs/sdk.md#inlineextension).
- **New inherited model and transport support** - GPT-5.6 metadata, Copilot Claude Sonnet 5, and zstd Codex SSE transport are available through inherited provider support. See [Providers](docs/providers.md) and [Model Options](docs/usage.md#model-options).

### Added

- Added inherited OpenAI GPT-5.6 model metadata for `gpt-5.6`, `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna`, plus verified `openai-codex` support for `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna`.
- Added inherited Claude Sonnet 5 to the GitHub Copilot model catalog ([#6200](https://github.com/earendil-works/pi/issues/6200)).
- Added inherited zstd request-body compression for the OpenAI Codex Responses SSE transport.
- Added `/login <provider>` support with provider autocomplete.
- Added public SDK exports for CLI-equivalent model and scoped-model resolution ([#6201](https://github.com/earendil-works/pi/issues/6201)).
- Added extension and RPC `agent_settled` events plus session-level idle waiting for fully settled agent runs ([#6363](https://github.com/earendil-works/pi/issues/6363)).
- Added `before_provider_headers` extension hook support for injecting provider request headers ([#6350](https://github.com/earendil-works/pi/pull/6350) by [@pmateusz](https://github.com/pmateusz)).
- Added an `InlineExtension` type for named inline extension factories ([#6267](https://github.com/earendil-works/pi/pull/6267) by [@any-victor](https://github.com/any-victor)).
- Added extension entry renderers for persisted display-only session entries that are rendered in interactive mode without being sent to the model context.
- Added project-local resource override management to `pi config`, including project mode startup with `pi config -l` and Tab switching between global and project scopes ([#6309](https://github.com/earendil-works/pi/pull/6309)).
- Added inherited `InMemorySessionStorage` and `JsonlSessionStorage` exports from the agent harness ([#6435](https://github.com/earendil-works/pi/issues/6435)).
- Added inherited custom metadata support in JSONL session headers ([#6417](https://github.com/earendil-works/pi/pull/6417) by [@ArcadiaLin](https://github.com/ArcadiaLin)).
- Added a `showCacheMissNotices` setting and `/settings` toggle for significant prompt-cache miss transcript notices.

### Fixed

- Fixed inherited retry classification for gRPC `ResourceExhausted` provider errors such as NVIDIA NIM transient exhaustion responses ([#6449](https://github.com/earendil-works/pi/pull/6449) by [@davidbrai](https://github.com/davidbrai)).
- Fixed inherited retry classification for Cloudflare 524 timeout responses ([#6239](https://github.com/earendil-works/pi/issues/6239)).
- Fixed inherited GitHub Copilot device-code login polling to wait before the first token poll and to honor server-provided `slow_down` intervals, avoiding incorrect failures or apparent hangs after browser authorization ([#6187](https://github.com/earendil-works/pi/issues/6187)).
- Fixed inherited OpenAI Codex WebSocket sessions to rotate cached connections before the backend's 60-minute limit, avoiding connection-limit failures on long sessions ([#6268](https://github.com/earendil-works/pi/issues/6268)).
- Fixed inherited DS4 server context overflow detection for `Prompt has ... tokens, but the configured context size is ... tokens` errors ([#6262](https://github.com/earendil-works/pi/issues/6262)).
- Fixed inherited Fireworks GLM 5.2 Fast to use the OpenAI-compatible endpoint and `thinkingLevelMap`, aligning it with GLM 5.2 ([#6195](https://github.com/earendil-works/pi/issues/6195)).
- Fixed the fork menu to ignore duplicate selection of the same entry ([#6430](https://github.com/earendil-works/pi/pull/6430) by [@davidbrai](https://github.com/davidbrai)).
- Fixed native clipboard support in Bun standalone releases ([#6418](https://github.com/earendil-works/pi/pull/6418) by [@davidbrai](https://github.com/davidbrai)).
- Fixed inherited GitHub Copilot extended context window models to use `contextWindow: 1000000`, preventing premature compaction and under-budgeting ([#6439](https://github.com/earendil-works/pi/issues/6439)).
- Fixed inherited editor paste marker accounting when paste markers are deleted or terminal state is cleared ([#6397](https://github.com/earendil-works/pi/pull/6397) by [@affanali2k3](https://github.com/affanali2k3)).
- Fixed `null` message content from imported transcripts or custom clients to normalize at ingestion boundaries instead of failing during context construction ([#6343](https://github.com/earendil-works/pi/pull/6343)).
- Fixed inherited tool calls from length-truncated assistant messages to fail instead of waiting for missing tool results ([#6285](https://github.com/earendil-works/pi/pull/6285)).
- Fixed inherited OpenAI Completions and Responses providers to send `(no tool output)` instead of `(see attached image)` when a tool result has empty text and no image content.
- Fixed inherited OpenAI Responses and Azure OpenAI Responses requests to avoid sending `max_output_tokens` values below the provider minimum ([#6265](https://github.com/earendil-works/pi/issues/6265)).
- Fixed inherited Amazon Bedrock prompt-cache points for Claude Fable 5 and Claude Sonnet 5 ([#6235](https://github.com/earendil-works/pi/issues/6235)).
- Fixed inherited Amazon Bedrock Claude 5 prompt-cache pricing metadata by removing stale fallback overrides.
- Fixed inherited OpenAI Codex user-agent construction to synchronously load Node OS metadata, avoiding a startup race that could report `pi (browser)` in Node/Bun.
- Fixed `pi update` for pnpm installations to suggest pruning pnpm's self-update cache when the executable points at a removed cached version ([#6279](https://github.com/earendil-works/pi/pull/6279) by [@rajp152k](https://github.com/rajp152k)).
- Fixed Xiaomi Token Plan model metadata to follow the upstream models.dev token-plan catalogs, removing unsupported `mimo-v2-omni` variants ([#6204](https://github.com/earendil-works/pi/issues/6204)).
- Fixed startup model selection to skip unauthenticated saved defaults so configured local custom models can be selected instead ([#6231](https://github.com/earendil-works/pi/issues/6231)).
- Fixed the question extension example to run question tool calls sequentially so multiple questions in one assistant turn remain answerable ([#6189](https://github.com/earendil-works/pi/issues/6189)).
- Fixed `/login` to report auth storage persistence failures instead of claiming credentials were saved when `auth.json` is locked ([#6223](https://github.com/earendil-works/pi/issues/6223)).
- Fixed split-turn compaction to serialize summary requests so single-concurrency local providers do not fail with 429 errors ([#5536](https://github.com/earendil-works/pi/issues/5536)).
- Fixed compaction retained-token budgeting to count context-visible custom messages ([#6326](https://github.com/earendil-works/pi/issues/6326)).
- Fixed custom session entries appended during assistant streaming to render before the live assistant message, matching persisted session order.
- Fixed non-positive or oversized bash tool timeouts to fail with a clear validation error instead of being clamped to an immediate timeout ([#6181](https://github.com/earendil-works/pi/issues/6181)).
- Fixed the edit tool schema to allow model-invented extra replacement fields instead of rejecting otherwise valid edits ([#6278](https://github.com/earendil-works/pi/issues/6278)).
- Fixed new session resets to clear cached label timestamps ([#6354](https://github.com/earendil-works/pi/issues/6354)).
- Fixed auto-retry for Bun fetch socket-drop errors reported as `socket connection was closed`, so transient provider disconnects do not end headless runs without retrying ([#6431](https://github.com/earendil-works/pi/issues/6431)).
- Fixed `models.json` `modelOverrides` to apply to extension-registered provider models ([#6367](https://github.com/earendil-works/pi/issues/6367)).
- Fixed project context file discovery to use stable parent traversal on Windows so startup no longer hangs while loading AGENTS.md or CLAUDE.md ([#6369](https://github.com/earendil-works/pi/issues/6369)).
- Fixed `--session-id` startup to warn when no existing project session has that id and pi creates a new session ([#6407](https://github.com/earendil-works/pi/issues/6407)).
- Fixed `/reload` help text and docs to consistently mention themes and context files ([#6395](https://github.com/earendil-works/pi/issues/6395)).

### Removed

- Removed default attribution headers from Vercel AI Gateway requests.
