# Pi upstream watch — 2026-06-24

Package: `@earendil-works/pi-coding-agent`
Checkpoint: `0.75.1`
Latest upstream: `0.80.2`

## Agent review checklist

Classify every entry below as `adapt`, `leverage`, `watch`, or `irrelevant`. Cross-reference local extension code before recommending action. Do not update `docs/upstream-watch/state.json` until the review is accepted.

Local surfaces to check first: `packages/ext/index.ts`, `packages/ext/config.ts`, `packages/ext/tools.ts`, `packages/ext/explore/`, `packages/ext/statusline.ts`, `packages/ext/notifications.ts`, `packages/ext/file-search/`, `packages/ext/inline-references/`, `packages/tau/`, and docs under `README.md`.

## Upstream entries

## 0.80.2

### Changed

- Changed inherited pi-ai `ApiKeyCredential` to use the `auth.json`-compatible discriminator `type: "api_key"` and provider-scoped `env` values instead of `type: "api-key"` and metadata.
- Renamed the inherited agent-core public harness shell execution options type from `ExecutionEnvExecOptions` to `ShellExecOptions`.

### Fixed

- Fixed inherited Anthropic-compatible custom models to use explicit compatibility metadata instead of provider-name heuristics for session-affinity headers and unsupported tool-field omissions.
- Fixed inherited request-scoped `apiKey` and `env` values to participate in provider auth resolution, so providers such as Cloudflare can derive request-specific base URLs from explicit call options ([#6021](https://github.com/earendil-works/pi/issues/6021)).
- Restored inherited temporary legacy per-API stream aliases such as `streamSimpleOpenAICompletions` on the pi-ai compat entrypoint ([#6016](https://github.com/earendil-works/pi/issues/6016), [#6017](https://github.com/earendil-works/pi/issues/6017)).
- Restored inherited runtime `detectCompat` fallback in `openai-completions` for models without explicit compat metadata ([#6020](https://github.com/earendil-works/pi/issues/6020)).

## 0.80.1

### Fixed

- Fixed inherited Amazon Bedrock scoped `AWS_PROFILE` endpoint resolution for built-in inference profile endpoints.
- Fixed inherited Fireworks Anthropic-compatible requests to apply session-affinity and unsupported tool-field defaults for custom Fireworks models.
- Fixed inherited Together MiniMax M2.7 metadata to avoid unsupported Together reasoning toggles.

## 0.80.0

### Changed

- Added `Ctrl+J` as a default newline keybinding alongside `Shift+Enter`.
- Renamed the displayed `zai` provider label to ZAI Coding Plan (Global) for clarity ([#5965](https://github.com/earendil-works/pi/issues/5965)).
- pi-ai's old global API (`stream`/`complete`/`completeSimple`, `getModel`/`getModels`/`getProviders`, `registerApiProvider`, `getEnvApiKey`, ...) moved off the `@earendil-works/pi-ai` root entrypoint to `@earendil-works/pi-ai/compat`. Extensions are not affected at runtime: the extension loader resolves the pi-ai root to the compat entrypoint (a strict superset), so existing extensions keep working unchanged. Extension sources that typecheck against pi-ai's published types should switch those imports to `@earendil-works/pi-ai/compat` (or migrate to the new `createModels()`/provider-factory API). The compat entrypoint and the loader alias will be removed in a future release with a migration guide.

### Fixed

- Fixed session names to normalize newline characters before storing or displaying labels ([#5999](https://github.com/earendil-works/pi/pull/5999) by [@haoqixu](https://github.com/haoqixu)).
- Fixed the session selector to order threaded session trees by the latest activity anywhere in each subtree ([#5784](https://github.com/earendil-works/pi/pull/5784) by [@Perlence](https://github.com/Perlence)).
- Fixed extension-related crash and startup-failure reporting to suggest restarting with `pi -ne`.
- Fixed inherited OpenAI Responses streams to fail before missing terminal events and fixed context usage and compaction estimates to ignore malformed all-zero assistant usage after truncated responses ([#5526](https://github.com/earendil-works/pi/pull/5526) by [@dmmulroy](https://github.com/dmmulroy)).
- Fixed inherited OpenAI Codex Responses WebSocket sessions to reconnect once when OpenAI's connection limit is reached before output starts ([#5973](https://github.com/earendil-works/pi/issues/5973)).
- Fixed inherited Amazon Bedrock endpoint resolution to honor scoped `AWS_PROFILE` values.
- Fixed inherited Cloudflare providers to require account/gateway configuration and route built-in compat calls through provider auth.
- Fixed provider-scoped auth environment values to reach inherited `Models`/`ImagesModels` API calls and compat API-key injection.
- Fixed inherited OpenCode Go GLM-5.2 metadata to expose `xhigh` reasoning and send the provider's max reasoning effort ([#5967](https://github.com/earendil-works/pi/issues/5967)).
- Fixed `pi --resume` to load user package themes and resolve automatic light/dark theme settings.
- Fixed `models.json` custom providers so stored credentials can satisfy auth without a redundant provider-level `apiKey` ([#5953](https://github.com/earendil-works/pi/issues/5953)).

### Removed

- Removed inherited selective-provider `@earendil-works/pi-ai/base` and `@earendil-works/pi-agent-core/base` entrypoints; use the root packages with explicit `Models` provider factories instead.

## 0.79.10

### New Features

- **Extension compaction event context** - Extension `session_before_compact` and `session_compact` events now include `reason` and `willRetry`, so extensions can distinguish manual `/compact`, threshold auto-compaction, and overflow retry flows. See [session_before_compact / session_compact](docs/extensions.md#session_before_compact--session_compact) and [Custom Summarization via Extensions](docs/compaction.md#custom-summarization-via-extensions).
- **Safer update flow** - `pi update` installs the exact checked Pi version, and update notices show the changelog URL, making upgrades more predictable. See [Install and Manage](docs/packages.md#install-and-manage).

### Added

- Added `reason` and `willRetry` metadata to extension `session_before_compact` and `session_compact` events so extensions can distinguish manual, threshold, and overflow compaction flows ([#5962](https://github.com/earendil-works/pi/pull/5962) by [@PizzaMarinara](https://github.com/PizzaMarinara)).

### Fixed

- Fixed the `find` tool to respect nested git repository boundaries when parent `.gitignore` rules ignore the nested repo ([#5960](https://github.com/earendil-works/pi/issues/5960)).
- Fixed the usage docs slash command table to include `/trust` and `/import` ([#5959](https://github.com/earendil-works/pi/issues/5959)).
- Fixed inherited OpenAI-compatible streaming to preserve encrypted `reasoning_details` that arrive before matching tool call deltas ([#5114](https://github.com/earendil-works/pi/issues/5114)).
- Fixed broken TUI documentation links to the plan-mode extension example ([#5957](https://github.com/earendil-works/pi/issues/5957)).
- Fixed transient extension UI and session-start messages emitted during session replacement or reload so they remain visible, and kept reload input blocked until reload completes ([#5943](https://github.com/earendil-works/pi/issues/5943)).
- Fixed the plan-mode example to preserve active custom tools, skip the action prompt when no plan is found, and queue refinement/execution follow-ups correctly from `agent_end` ([#5940](https://github.com/earendil-works/pi/issues/5940)).
- Fixed `pi update` to install the exact version returned by the Pi update check, make `--force` reinstall that checked version, fail instead of falling back to an unversioned reinstall when no version is available, and report both the old and updated versions.
- Fixed update notifications to display the actual changelog URL as the hyperlink text.

## 0.79.9

### New Features

- **Chat-template thinking compatibility** - OpenAI-compatible custom providers can map Pi thinking levels into `chat_template_kwargs`, enabling vLLM/Hugging Face chat-template models such as DeepSeek to use provider-native thinking controls. See [Custom Provider API Types](docs/custom-provider.md#api-types) and [OpenAI Compatibility](docs/models.md#openai-compatibility).
- **GLM-5.2 provider improvements** - GLM-5.2 now has corrected Fireworks OpenAI-compatible routing and OpenRouter `xhigh` thinking support, improving `/model` behavior and high-effort reasoning for GLM-5.2 users. See [Model Options](docs/usage.md#model-options).

### Added

- Added inherited configurable `chat-template` thinking support for OpenAI-compatible providers that use `chat_template_kwargs`, such as DeepSeek models behind vLLM ([#5673](https://github.com/earendil-works/pi/issues/5673)).

### Fixed

- Fixed inherited Fireworks GLM-5.2 metadata to use the OpenAI-compatible Chat Completions endpoint with `reasoning_effort` support ([#5923](https://github.com/earendil-works/pi/issues/5923)).
- Fixed same-directory session switches to reuse imported extension modules while preserving fresh extension instances and lifecycle events ([#5905](https://github.com/earendil-works/pi/issues/5905)).
- Fixed deep session branches taking quadratic time to build context or branch paths ([#5909](https://github.com/earendil-works/pi/issues/5909)).
- Fixed inherited OpenRouter GLM-5.2 metadata to expose `xhigh` reasoning and send OpenRouter's native `xhigh` effort ([#5770](https://github.com/earendil-works/pi/issues/5770)).
- Fixed inherited Markdown streaming code fence rendering so partial closing fences no longer make code blocks shrink or flicker while content streams ([#5846](https://github.com/earendil-works/pi/pull/5846) by [@xl0](https://github.com/xl0)).
- Fixed fuzzy `edit` matches to preserve untouched line blocks instead of rewriting the whole file through normalized content ([#5899](https://github.com/earendil-works/pi/issues/5899)).
- Fixed bash commands through legacy WSL `bash.exe` to pass scripts over stdin so shell variables expand in the target bash ([#5893](https://github.com/earendil-works/pi/issues/5893)).
- Fixed `/model` to hide GitHub Copilot models that are unavailable to the authenticated account ([#5897](https://github.com/earendil-works/pi/issues/5897)).
- Fixed `/model` selector search to rank exact provider-prefixed matches before proxy-provider model ID matches ([#5892](https://github.com/earendil-works/pi/issues/5892)).

## 0.79.8

### New Features

- **Selective provider base entry points** - SDK users can pair `@earendil-works/pi-ai/base` and `@earendil-works/pi-agent-core/base` with explicit provider registration to keep bundled applications from including unused provider transports. See [`pi-ai` Base Entry Point](../ai/README.md#base-entry-point) and [`pi-agent-core` Base Entry Point](../agent/README.md#base-entry-point).
- **Mistral prompt caching** - Mistral sessions now use provider-side prompt caching with session affinity and cached-token usage/cost accounting. See [API Keys](docs/providers.md#api-keys) and [Environment Variables](docs/usage.md#environment-variables).
- **Post-compaction token estimates** - Compact results and compaction events now include estimated post-compaction token counts so clients can show the approximate context reduction. See [RPC compact](docs/rpc.md#compact) and [compaction events](docs/rpc.md#compaction_start--compaction_end).
- **OpenRouter Fusion alias** - `openrouter/fusion` is available as a built-in OpenRouter model alias. See [API Keys](docs/providers.md#api-keys).

### Added

- Added inherited `@earendil-works/pi-ai/base` and `@earendil-works/pi-agent-core/base` entry points for selective provider registration in bundled applications ([#5348](https://github.com/earendil-works/pi/pull/5348) by [@FredKSchott](https://github.com/FredKSchott)).
- Added inherited Mistral prompt caching using the pi session ID as `prompt_cache_key`, including cached-token usage and cost accounting ([#5854](https://github.com/earendil-works/pi/issues/5854)).
- Added estimated post-compaction token counts to compact results and compaction events ([#5877](https://github.com/earendil-works/pi/issues/5877)).
- Added the inherited OpenRouter Fusion alias as `openrouter/fusion` ([#5866](https://github.com/earendil-works/pi/pull/5866) by [@dannote](https://github.com/dannote)).

### Fixed

- Updated vulnerable runtime dependencies, including `undici` and the packaged `protobufjs` transitive dependency.
- Fixed compaction to refuse sessions with no eligible messages instead of producing empty summaries ([#4811](https://github.com/earendil-works/pi/issues/4811)).
- Fixed successful overflow-triggered auto-compaction to avoid retrying completed assistant responses ([#5720](https://github.com/earendil-works/pi/issues/5720)).

## 0.79.7

### New Features

- **Automatic theme mode** - `/settings` can choose separate light and dark themes and follow terminal color-scheme changes. See [Selecting a Theme](docs/themes.md#selecting-a-theme).
- **Self-only updates by default** - `pi update` now updates pi only, with `pi update --all` for updating pi and packages together. See [Install and Manage](docs/packages.md#install-and-manage).
- **Extension API helpers** - extensions can use `CONFIG_DIR_NAME` for project config paths and import edit diff helpers for edit-style diffs. See [`ctx.cwd`](docs/extensions.md#ctxcwd) and [SDK Exports](docs/sdk.md#exports).
- **Warp inline images** - Warp terminals now get inline image rendering through Kitty graphics detection. See [Image](docs/tui.md#image).

### Added

- Added automatic theme mode so `/settings` can use separate light and dark themes and follow terminal color-scheme changes ([#5874](https://github.com/earendil-works/pi/pull/5874)).
- Added inherited Warp terminal image capability detection so inline images render through Warp's Kitty graphics support ([#5841](https://github.com/earendil-works/pi/pull/5841) by [@dodiego](https://github.com/dodiego)).
- Exported `CONFIG_DIR_NAME` from the coding-agent public API so extensions can resolve project config paths without hardcoding `.pi` ([#5869](https://github.com/earendil-works/pi/pull/5869) by [@xl0](https://github.com/xl0)).
- Exported edit diff helpers (`generateDiffString`, `generateUnifiedPatch`, and `EditDiffResult`) from the public API for extensions that need edit-style diffs ([#5756](https://github.com/earendil-works/pi/pull/5756) by [@xl0](https://github.com/xl0)).

### Changed

- Changed bare `pi update` to update only pi, added `pi update --all` for updating pi and extensions together, and clarified extension update prompts.
- Reserved `/` in theme names for automatic light/dark theme settings.
- Updated extension docs, examples, runtime help, trust prompts, and config labels to use the configured project config directory instead of hardcoded `.pi` paths.

### Fixed

- Fixed RPC unknown-command errors to include the request id so clients do not hang waiting for a response ([#5868](https://github.com/earendil-works/pi/issues/5868)).
- Fixed `/model` autocomplete and model selection searches to match provider/model queries regardless of whether the provider or model token is typed first.
- Fixed the tree navigator to horizontally pan deep entries so the selected item remains readable ([#5830](https://github.com/earendil-works/pi/issues/5830)).

## 0.79.6

### Fixed

- Fixed HTTP dispatcher configuration to preserve a caller's deliberate `fetch` override instead of reinstalling the undici global fetch over it.
- Fixed inherited OpenCode Go DeepSeek V4 thinking-off requests to send the provider's `thinking: { type: "disabled" }` compatibility parameter.

## 0.79.5

### New Features

- **Provider-scoped API key environments** - `auth.json` API key entries can now include `env` overrides for provider-specific Cloudflare, Azure OpenAI, Google Vertex, Amazon Bedrock, cache retention, and proxy settings without changing the project shell. See [Auth File](docs/providers.md#auth-file).
- **Global HTTP proxy setting** - Configure `httpProxy` once in global settings to apply `HTTP_PROXY` and `HTTPS_PROXY` to Pi-managed HTTP clients. See [Network](docs/settings.md#network).
- **Vercel AI Gateway attribution** - Vercel AI Gateway requests now include Pi attribution headers by default. See [API Keys](docs/providers.md#api-keys).

### Added

- Added Vercel AI Gateway request attribution headers (`http-referer` and `x-title`) for Vercel AI Gateway models ([#5798](https://github.com/earendil-works/pi/pull/5798) by [@rwachtler](https://github.com/rwachtler)).
- Added an `xp` footer marker when experimental features are enabled.
- Added a global `httpProxy` setting that applies as `HTTP_PROXY` and `HTTPS_PROXY` for Pi-managed HTTP clients ([#5790](https://github.com/earendil-works/pi/issues/5790)).
- Added `auth.json` API key `env` values so provider-specific environment overrides can be scoped to Pi and propagated to inherited provider configuration ([#5728](https://github.com/earendil-works/pi/issues/5728)).

### Changed

- Updated the vendored Markdown parser used by HTML session exports to `marked` 18.0.5.

### Fixed

- Fixed inherited OpenAI Responses streaming to tolerate null message content from OpenAI-compatible servers before tool calls ([#5819](https://github.com/earendil-works/pi/issues/5819)).
- Fixed inherited OpenCode DeepSeek V4 thinking requests to avoid sending both `thinking` and `reasoning_effort` ([#5818](https://github.com/earendil-works/pi/issues/5818)).
- Fixed device-code login to stop opening the browser automatically.
- Fixed inherited editor Cursor Up handling so non-empty drafts jump to the start of the line before browsing input history ([#5789](https://github.com/earendil-works/pi/pull/5789) by [@4h9fbZ](https://github.com/4h9fbZ)).
- Fixed inherited Z.AI GLM-5.2 thinking requests to send `reasoning_effort` with the provider's `high`/`max` effort mapping ([#5770](https://github.com/earendil-works/pi/issues/5770)).
- Fixed successful `pi update` on Windows to exit naturally instead of calling `process.exit(0)`, avoiding a Node.js/libuv assertion after version-check network requests ([#5805](https://github.com/earendil-works/pi/issues/5805)).
- Fixed inherited Google and `google-vertex` Gemini model metadata to map `latest` aliases to the current models, add Gemini 3.5 Flash for Vertex, correct Gemini 2.5 Flash Vertex cache pricing, and remove shut-down Vertex preview models ([#5761](https://github.com/earendil-works/pi/issues/5761)).
- Fixed the session selector to stay open and show the all-sessions empty state when both current-folder and all-scope session lists are empty ([#5747](https://github.com/earendil-works/pi/issues/5747)).
- Fixed inherited Moonshot AI China model metadata to include Kimi K2.7 Code, and omitted unsupported thinking-off payloads for Kimi K2.7 Code models ([#5760](https://github.com/earendil-works/pi/issues/5760)).

## 0.79.4

### New Features

- **Automatic first-run theme selection** - pi detects the terminal background on first run and defaults to the `dark` or `light` theme. See [Selecting a Theme](docs/themes.md#selecting-a-theme).
- **Standalone binary integrity checksums** - GitHub release assets now include `SHA256SUMS` files for verifying standalone binary downloads. See [Quickstart Install](docs/quickstart.md#install).

### Added

- Added `SHA256SUMS` integrity files to standalone binary GitHub release assets ([#5739](https://github.com/earendil-works/pi/issues/5739)).
- Added first-run interactive theme detection from the terminal background ([#5385](https://github.com/earendil-works/pi/pull/5385) by [@vegarsti](https://github.com/vegarsti)).

### Fixed

- Fixed bash tool output collection to keep draining stdout/stderr after the child exits while descendants still write, avoiding truncated late output ([#5753](https://github.com/earendil-works/pi/pull/5753) by [@Mearman](https://github.com/Mearman)).
- Fixed `/tree` help rendering to show compact wrapped controls instead of truncating them on narrow terminals ([#5055](https://github.com/earendil-works/pi/issues/5055)).
- Fixed SIGTERM/SIGHUP interactive shutdown to keep signal handlers installed until terminal cleanup completes, preventing `signal-exit` from re-sending the signal and leaving the terminal in raw/Kitty keyboard mode ([#5724](https://github.com/earendil-works/pi/issues/5724)).
- Fixed extensions documentation to clarify that `pi.getActiveTools()` returns active tool names while `pi.getAllTools()` returns tool metadata ([#5729](https://github.com/earendil-works/pi/issues/5729)).
- Fixed question and questionnaire extension examples to wrap long prompt, option, and help text instead of truncating it ([#5708](https://github.com/earendil-works/pi/pull/5708) by [@xl0](https://github.com/xl0)).
- Fixed package commands such as `pi list`, `pi install`, and `pi update` to terminate after completing even if an extension leaves background handles open ([#5687](https://github.com/earendil-works/pi/issues/5687)).
- Fixed `pi update` for pnpm global installs whose configured `global-bin-dir` no longer matches the active pnpm home ([#5689](https://github.com/earendil-works/pi/issues/5689)).
- Fixed npm package specs that use ranges or tags (for example `@^1.2.7`) so installed package resources still load instead of being treated as mismatched exact pins ([#5695](https://github.com/earendil-works/pi/issues/5695)).
- Fixed inherited Anthropic 1-hour prompt-cache write cost accounting to price 1-hour cache writes at 2x input instead of the 5-minute cache-write rate ([#5738](https://github.com/earendil-works/pi/pull/5738) by [@theBucky](https://github.com/theBucky)).
- Fixed inherited GitHub Copilot Claude adaptive-thinking effort metadata to match manually checked Copilot model capabilities ([#4637](https://github.com/earendil-works/pi/issues/4637)).
- Fixed inherited OpenCode/OpenCode Go completion model metadata to omit long-retention cache fields for routes that reject `prompt_cache_retention` ([#5702](https://github.com/earendil-works/pi/issues/5702)).
- Fixed inherited overlay compositing over CJK wide characters so borders stay aligned when an overlay starts inside a full-width cell ([#5297](https://github.com/earendil-works/pi/issues/5297)).
- Fixed inherited WezTerm inline Kitty image rendering during full redraw fallbacks so image padding rows are reserved before the placement is drawn without regressing tall-image placement ([#5618](https://github.com/earendil-works/pi/issues/5618), [#4415](https://github.com/earendil-works/pi/issues/4415)).
- Fixed custom provider config so plain uppercase API key and header values remain literals instead of being treated as legacy environment references; use explicit `$ENV_VAR` syntax for environment variables ([#5661](https://github.com/earendil-works/pi/issues/5661)).

## 0.79.3

### Fixed

- Fixed inherited OpenAI GPT-5.4/GPT-5.5 and OpenAI Codex GPT-5.4/GPT-5.4 mini/GPT-5.5 context window metadata to use the observed 272k-token Codex backend limit, avoiding a billing hazard from prompts above Codex's accepted limit (reported by [@trethore](https://github.com/trethore)).

## 0.79.2

### New Features

- **Clearer Bedrock validation guidance** - Amazon Bedrock data retention validation errors now link to AWS data retention documentation. See [Amazon Bedrock](docs/providers.md#amazon-bedrock).

### Added

- Added an experimental first-time setup flow behind `PI_EXPERIMENTAL=1` that asks for a dark/light theme choice (preselecting the detected appearance) and opt-in analytics data sharing on first launch with the default agent directory; opting in stores a `trackingId` in `settings.json` ([#5587](https://github.com/earendil-works/pi/pull/5587) by [@vegarsti](https://github.com/vegarsti)).
- Added AWS data retention documentation links to inherited Amazon Bedrock unsupported data retention mode validation errors ([#5561](https://github.com/earendil-works/pi/pull/5561) by [@unexge](https://github.com/unexge)).

### Fixed

- Fixed project trust detection to ignore global `~/.pi/agent` state when running from `$HOME`, and made `pi update` use only saved or explicit project trust without prompting ([#5619](https://github.com/earendil-works/pi/issues/5619)).
- Fixed experimental first-time setup to skip forked sessions instead of rerunning the setup prompts ([#5627](https://github.com/earendil-works/pi/pull/5627) by [@vegarsti](https://github.com/vegarsti)).
- Fixed inherited OpenAI-compatible context overflow detection for parenthesized `maximum context length (N)` errors ([#5677](https://github.com/earendil-works/pi/issues/5677)).
- Fixed inherited OpenAI GPT-5.4/GPT-5.5 and OpenAI Codex GPT-5.4/GPT-5.4 mini/GPT-5.5 context window metadata to match current OpenAI limits ([#5644](https://github.com/earendil-works/pi/issues/5644)).
- Fixed inherited Anthropic refusal stops to preserve provider `stop_details` explanations in error messages ([#5666](https://github.com/earendil-works/pi/pull/5666) by [@rwachtler](https://github.com/rwachtler)).
- Increased the inherited OpenAI Codex Responses SSE response-header timeout to 20 seconds to reduce false-positive stalls while retaining the bounded wait introduced for zero-event hangs ([#4945](https://github.com/earendil-works/pi/issues/4945)).
- Fixed inherited Claude Fable 5 thinking-off requests to omit Anthropic's unsupported `thinking.type: "disabled"` payload ([#5567](https://github.com/earendil-works/pi/pull/5567) by [@tmustier](https://github.com/tmustier)).
- Fixed inherited late tool progress callbacks after tool settlement to be ignored instead of emitting stale `tool_execution_update` events ([#5573](https://github.com/earendil-works/pi/issues/5573)).
- Fixed inherited user-message transcript rendering so standalone `+` messages no longer render as `-` ([#5657](https://github.com/earendil-works/pi/issues/5657)).
- Fixed inherited slash-separated fuzzy queries so provider/model completions remain matchable after insertion.
- Fixed inherited WezTerm inline Kitty image rendering so reserved row clears do not erase all but the top strip of tool image previews ([#5618](https://github.com/earendil-works/pi/issues/5618)).
- Fixed inherited editor wrapping for CJK text to break at character boundaries instead of leaving large trailing gaps ([#5585](https://github.com/earendil-works/pi/pull/5585) by [@haoqixu](https://github.com/haoqixu)).
- Fixed inherited loose Markdown list rendering to preserve blank-line separation between list items ([#5562](https://github.com/earendil-works/pi/pull/5562) by [@Perlence](https://github.com/Perlence)).
- Fixed `--model` resolution for authenticated custom model IDs whose slash prefix matches an unauthenticated built-in provider ([#5643](https://github.com/earendil-works/pi/issues/5643)).
- Fixed `/fork` to keep session parent chains connected when the forked path contains labels ([#5669](https://github.com/earendil-works/pi/issues/5669)).
- Fixed `/share` and `/export` HTML exports to use the active fallback theme when the configured custom theme no longer exists ([#5596](https://github.com/earendil-works/pi/issues/5596)).
- Fixed custom fallback model IDs with `:<thinking>` suffixes to preserve the requested thinking level when the provider template model does not advertise reasoning ([#5560](https://github.com/earendil-works/pi/pull/5560) by [@haoqixu](https://github.com/haoqixu)).

## 0.79.1

### New Features

- **Claude Fable 5** - Claude Fable 5 is now available on the Anthropic and Amazon Bedrock providers, with adaptive thinking and `xhigh` effort support.
- **Prompt template defaults** - Prompt templates can use default positional arguments such as `${1:-7}` for optional values. See [Prompt Template Arguments](docs/prompt-templates.md#arguments).
- **Configurable project trust defaults** - `defaultProjectTrust` lets users choose whether unresolved project trust asks, always trusts, or never trusts by default, and extensions can inspect effective trust decisions. See [Project Trust](docs/security.md#project-trust) and [`ctx.isProjectTrusted()`](docs/extensions.md#ctxisprojecttrusted).
- **Natural extension autocomplete triggers** - Extension autocomplete providers can declare trigger characters such as `#` or `$` so suggestions open without slash-command prefixes. See [Autocomplete Providers](docs/extensions.md#autocomplete-providers).

### Added

- Added default-value expansion for prompt template positional arguments, e.g. `${1:-7}` ([#5553](https://github.com/earendil-works/pi/pull/5553) by [@dannote](https://github.com/dannote)).
- Added `areExperimentalFeaturesEnabled` feature guard to allow users to opt in to early features ([#5547](https://github.com/earendil-works/pi/pull/5547) by [@vegarsti](https://github.com/vegarsti)).
- Added `ctx.isProjectTrusted()` for extensions to observe the effective project trust decision, including temporary trust decisions ([#5523](https://github.com/earendil-works/pi/issues/5523)).
- Added a global `defaultProjectTrust` setting to choose whether unresolved project trust asks, always trusts, or never trusts by default.
- Added extension autocomplete trigger character support for `ctx.ui.addAutocompleteProvider()` wrappers ([#4703](https://github.com/earendil-works/pi/issues/4703)).
- Added Claude Fable 5 model support inherited from `@earendil-works/pi-ai` for the Anthropic and Amazon Bedrock providers, with adaptive thinking and `xhigh` effort support.

### Fixed

- Fixed inherited Amazon Bedrock inference profile ARN region resolution to prefer the ARN's embedded region over `AWS_REGION` ([#5527](https://github.com/earendil-works/pi/pull/5527) by [@AJM10565](https://github.com/AJM10565)).
- Fixed inherited IME hardware cursor positioning while slash-command autocomplete is visible ([#5283](https://github.com/earendil-works/pi/pull/5283) by [@smoosex](https://github.com/smoosex)).
- Fixed inherited z.ai thinking-off requests to send the provider's `thinking: { type: "disabled" }` compatibility parameter ([#5330](https://github.com/earendil-works/pi/issues/5330)).
- Fixed inherited OpenCode completions model metadata to send explicit `maxTokens` as `max_tokens` ([#5331](https://github.com/earendil-works/pi/issues/5331)).
- Fixed inherited Moonshot Kimi thinking-off requests to send the provider's `thinking: { type: "disabled" }` compatibility parameter ([#5531](https://github.com/earendil-works/pi/issues/5531)).
- Fixed inherited Azure OpenAI Responses requests to disable server-side response storage ([#5530](https://github.com/earendil-works/pi/issues/5530)).
- Fixed inherited Azure GPT-5.4 and GPT-5.5 context window metadata to 1,050,000 tokens, matching Azure Foundry deployments instead of OpenAI's 272k limit ([#5559](https://github.com/earendil-works/pi/issues/5559)).
- Fixed inherited OpenAI and Azure GPT-5 Pro `maxTokens` metadata to 128,000, correcting an upstream value that duplicated the input sub-limit as the output limit ([#5559](https://github.com/earendil-works/pi/issues/5559)).
- Fixed inherited prompt history navigation to restore the current draft when returning from history browsing ([#5494](https://github.com/earendil-works/pi/issues/5494)).
- Fixed inherited wrapping for mixed Latin and CJK text so unspaced CJK runs can break at grapheme boundaries without leaving large trailing gaps ([#5495](https://github.com/earendil-works/pi/issues/5495)).
- Fixed extension OAuth login prompts to keep previous submitted prompt rows stable instead of mirroring the active input value ([#5433](https://github.com/earendil-works/pi/issues/5433)).
- Fixed `/reload` to apply updated `steeringMode` and `followUpMode` settings to the current session ([#5377](https://github.com/earendil-works/pi/issues/5377)).
- Fixed invalid `models.json` syntax to skip startup config migrations and report the normal file-path-aware models error instead of a raw JSON parse stack trace ([#5418](https://github.com/earendil-works/pi/issues/5418)).
- Fixed GitHub release notes and interactive changelog links to resolve package-relative documentation URLs correctly ([#5516](https://github.com/earendil-works/pi/issues/5516)).
- Fixed CLI help and version output, including plain redirected `--help`/`--version` output and simplified `list`/`config` help text.
- Fixed `/new` from ephemeral sessions to keep the new session ephemeral instead of persisting it by default ([#5045](https://github.com/earendil-works/pi/issues/5045)).
- Clarified custom model docs that `name` and `modelOverrides.name` do not replace model IDs in the footer or primary model lists ([#4841](https://github.com/earendil-works/pi/issues/4841)).

## 0.79.0

### New Features

- **Project trust for local inputs** - Pi now asks before loading project-local settings, resources, instructions, and packages, with saved decisions and `--approve` / `--no-approve` controls for non-interactive modes. See [Project Trust](README.md#project-trust).
- **Extension-controlled trust decisions** - Global and CLI extensions can handle `project_trust`, decide, remember, or defer project trust before project-local resources load. See [`project_trust`](docs/extensions.md#project_trust).
- **Cache-hit visibility in the footer** - The interactive footer now shows the latest prompt cache hit rate (`CH`). See [Interactive Mode](README.md#interactive-mode).
- **Richer SDK and RPC extension surfaces** - Public exports now include RPC extension UI request/response types and package asset path helpers. See [Extension UI Protocol](docs/rpc.md#extension-ui-protocol) and [SDK Exports](docs/sdk.md#exports).

### Added

- Added a `project_trust` extension event so global and CLI extensions can decide or defer project trust during startup and runtime cwd switches.
- Added project trust gating for project-local settings, resources, instructions, and packages ([#5332](https://github.com/earendil-works/pi/pull/5332)).
- Added the latest prompt cache hit rate to the interactive footer.
- Exported RPC extension UI request and response types from the public API ([#5455](https://github.com/earendil-works/pi/issues/5455)).
- Exported coding-agent package asset path helpers from the public API ([#5415](https://github.com/earendil-works/pi/issues/5415)).

### Fixed

- Fixed package exports by removing the stale `./hooks` subpath that pointed at non-existent build output.
- Fixed inherited TUI rendering to clear stale lines when content shrinks to zero.
- Fixed inherited autocomplete suggestions to refresh after editor cursor movement ([#5499](https://github.com/earendil-works/pi/pull/5499) by [@Roman-Galeev](https://github.com/Roman-Galeev)).
- Fixed `/reload` to persist project trust when an implicitly trusted session creates a project `.pi` directory.
- Fixed project trust input discovery to traverse parent directories portably.
- Fixed inherited intermittent Shift+Enter handling by making Kitty keyboard protocol fallback response-driven instead of timeout-driven ([#5188](https://github.com/earendil-works/pi/issues/5188)).
- Fixed the compaction summarization system prompt to use neutral AI assistant wording for non-coding agents ([#5401](https://github.com/earendil-works/pi/issues/5401)).
- Fixed `models.json` schema support and inherited OpenAI Responses custom-provider handling for `compat.supportsDeveloperRole: false` ([#5456](https://github.com/earendil-works/pi/issues/5456)).
- Fixed inherited prompt history navigation to place the cursor at the start when browsing upward and at the end when browsing downward ([#5454](https://github.com/earendil-works/pi/issues/5454)).
- Fixed tmux setup documentation to require tmux 3.5 for `extended-keys-format csi-u` and document the tmux 3.2-3.4 fallback ([#5432](https://github.com/earendil-works/pi/issues/5432)).
- Fixed inherited OpenRouter routing preferences on OpenAI-compatible custom providers to work when the custom provider base URL does not point directly at OpenRouter ([#5347](https://github.com/earendil-works/pi/issues/5347)).
- Fixed built-in tool expand hints to style closing parentheses consistently ([#5359](https://github.com/earendil-works/pi/issues/5359)).
- Fixed skill-wrapped prompts to insert spacing between skill instructions and the user message ([#5371](https://github.com/earendil-works/pi/pull/5371) by [@Perlence](https://github.com/Perlence)).

## 0.78.1

### New Features

- **More built-in provider coverage** - Added Ant Ling and NVIDIA NIM provider setup, plus MiniMax-M3 support for the direct MiniMax providers. See [Providers](docs/providers.md).
- **Richer extension context** - Extensions can use `ctx.mode` and `ctx.getSystemPromptOptions()` to adapt behavior across TUI, RPC, JSON, and print modes and inspect base system prompt inputs. See [Extensions](docs/extensions.md).

### Added

- Added containerization documentation and a Gondolin extension example for routing built-in tools into a local micro-VM.
- Added Ant Ling provider selection and setup documentation.
- Added MiniMax-M3 model support inherited from `@earendil-works/pi-ai` for the `minimax` and `minimax-cn` direct providers ([#5313](https://github.com/earendil-works/pi/issues/5313)).
- Added NVIDIA NIM provider selection, setup documentation, and direct NIM request attribution headers.
- Added `ctx.mode` to extension contexts so extensions can distinguish TUI, RPC, JSON, and print mode.
- Added `ctx.getSystemPromptOptions()` for extension commands to inspect the current base system prompt inputs ([#5306](https://github.com/earendil-works/pi/pull/5306) by [@xl0](https://github.com/xl0)).

### Fixed

- Fixed temporary extension package installs to use a private `~/.pi/agent/tmp/extensions` directory with `0700` permissions instead of `os.tmpdir()/pi-extensions`.
- Fixed git package source handling to reject unsafe host/path components and keep managed clone paths inside install roots.
- Fixed stored XSS in HTML session exports by sanitizing Markdown link and image URLs with a scheme allow-list after stripping control characters.
- Fixed SDK embedding in bundled Node apps failing with `ENOENT` when `package.json` is not present next to the bundle entrypoint. The package metadata reader now gracefully handles missing `package.json` by using defaults, enabling `createAgentSession()` without requiring package-adjacent files at runtime ([#5226](https://github.com/earendil-works/pi/issues/5226)).
- Fixed HTTP timeout setting not being respected for non-Codex providers (e.g., llama.cpp via OpenAI-compatible API). The `httpIdleTimeoutMs` setting (set via `/settings` HTTP timeout) now applies as the default SDK request timeout for all providers that support it, not just OpenAI Codex Responses. Disabling the timeout (HTTP timeout = false) now correctly disables SDK timeouts for all supported providers by sending a maximum int32 value (effectively infinite) instead of 0, since SDKs treat timeout=0 as an immediate timeout ([#5294](https://github.com/earendil-works/pi/issues/5294)).
- Fixed inherited Amazon Bedrock requests to replace blank required user/tool-result text with a placeholder and skip blank replay text blocks ([#4975](https://github.com/earendil-works/pi/issues/4975)).
- Fixed inherited Anthropic Claude Opus 4.7+ requests to suppress deprecated temperature parameters ([#5251](https://github.com/earendil-works/pi/pull/5251) by [@yzhg1983](https://github.com/yzhg1983)).
- Fixed inherited OpenAI GPT-5.5 generated metadata to omit unsupported minimal thinking ([#5243](https://github.com/earendil-works/pi/issues/5243)).
- Fixed inherited OpenRouter Kimi K2.6 thinking replay and developer-role instruction handling ([#5309](https://github.com/earendil-works/pi/issues/5309)).
- Fixed inherited OpenRouter reasoning instruction requests to preserve the system role when required ([#5221](https://github.com/earendil-works/pi/pull/5221) by [@PriNova](https://github.com/PriNova)).
- Fixed inherited overlay focus restoration so non-capturing overlays remain interactive after UI rerenders and explicit focus release ([#5235](https://github.com/earendil-works/pi/pull/5235) by [@nicobailon](https://github.com/nicobailon)).
- Fixed inherited tab width accounting in column slicing and overlay compositing so tab-containing output cannot exceed the terminal width ([#5218](https://github.com/earendil-works/pi/issues/5218)).
- Fixed opening and listing very large JSONL session files by reading session entries line-by-line instead of materializing the full file as one string ([#5231](https://github.com/earendil-works/pi/issues/5231)).
- Fixed the footer branch display in WSL `/mnt/...` repositories to refresh after branch changes ([#5264](https://github.com/earendil-works/pi/pull/5264) by [@psoukie](https://github.com/psoukie)).
- Fixed `renderShell: "self"` tool renderers that emit no component lines leaving a blank chat row ([#5299](https://github.com/earendil-works/pi/issues/5299)).
- Restored inherited NVIDIA Qwen 3.5 122B NIM model support.

## 0.78.0

### New Features

- **Named startup sessions** - `--name` / `-n` sets the session display name before startup across interactive, print, JSON, and RPC modes. See [Naming Sessions](docs/sessions.md#naming-sessions) and [Session Options](docs/usage.md#session-options).
- **Clickable file tool paths** - built-in file tool titles render OSC 8 `file://` hyperlinks when the terminal supports them, including supported tmux clients.

### Added

- Exported `convertToPng` for extension authors ([#5167](https://github.com/earendil-works/pi-mono/pull/5167) by [@xl0](https://github.com/xl0)).
- Exported `parseArgs` and type `Args` for extension authors ([#5202](https://github.com/earendil-works/pi-mono/pull/5202) by [@xl0](https://github.com/xl0)).
- Added `--name` / `-n` to set the session display name at startup ([#5153](https://github.com/earendil-works/pi-mono/issues/5153)).
- Added a resume command hint when exiting interactive sessions ([#5176](https://github.com/earendil-works/pi-mono/pull/5176) by [@yzhg1983](https://github.com/yzhg1983)).
- Added OSC 8 `file://` hyperlinks to file paths shown in built-in file tool titles ([#5189](https://github.com/earendil-works/pi-mono/pull/5189) by [@mpazik](https://github.com/mpazik)).
- Added custom Amazon Bedrock request header support inherited from `@earendil-works/pi-ai` ([#5178](https://github.com/earendil-works/pi-mono/pull/5178) by [@stephanmck](https://github.com/stephanmck)).

### Fixed

- Clarified the WezTerm/WSL IME hardware cursor docs to state that cursor visibility remains opt-in ([#5200](https://github.com/earendil-works/pi-mono/issues/5200)).
- Fixed the GitLab Duo custom provider example to use adaptive thinking for Claude models, expose xhigh thinking, and include newer verified model IDs ([#5201](https://github.com/earendil-works/pi-mono/issues/5201)).
- Fixed Bun release archive creation to install and copy the matching `@mariozechner/clipboard` base package and native sidecars ([#5184](https://github.com/earendil-works/pi-mono/issues/5184)).
- Fixed early interactive input typed before the prompt loop starts so it is buffered instead of dropped ([#5195](https://github.com/earendil-works/pi-mono/pull/5195) by [@yzhg1983](https://github.com/yzhg1983)).
- Fixed OpenRouter Moonshot Kimi K2.6 requests to use `system` instead of unsupported `developer` messages ([#5159](https://github.com/earendil-works/pi-mono/issues/5159)).
- Fixed OpenCode Go Kimi K2.6 thinking requests to send `thinking` objects instead of invalid string values, and fixed OpenCode Zen Grok Build thinking requests to omit unsupported `reasoning_effort` ([#5169](https://github.com/earendil-works/pi-mono/issues/5169)).
- Fixed OpenAI Codex Responses SSE streams to abort response body reads after terminal events.
- Fixed OpenCode Kimi K2.6 generated metadata to use Anthropic-style thinking metadata instead of invalid reasoning-effort parameters.
- Fixed OSC 8 hyperlinks to pass through tmux when the client supports them ([#5189](https://github.com/earendil-works/pi-mono/pull/5189) by [@mpazik](https://github.com/mpazik)).
- Fixed ANSI text wrapping to avoid stack overflows on very long wrapped lines ([#5185](https://github.com/earendil-works/pi-mono/issues/5185)).

## 0.77.0

### New Features

- **Claude Opus 4.8 support** - Adds Anthropic Claude Opus 4.8 metadata and updates Opus adaptive-thinking coverage.
- **Selective tool disablement** - `--exclude-tools` / `-xt` disables specific built-in, extension, or custom tools while leaving the rest available. See [Tool Options](docs/usage.md#tool-options).
- **Headless Codex subscription login** - `/login` can use device-code auth for ChatGPT Plus/Pro Codex subscriptions. See [Subscriptions](docs/providers.md#subscriptions) and [OpenAI Codex](docs/providers.md#openai-codex).
- **Streaming-aware extension input** - extensions can distinguish idle prompts, mid-stream steers, and queued follow-ups with `InputEvent.streamingBehavior`. See [Input Events](docs/extensions.md#input-events).

### Added

- Added `--exclude-tools` / `-xt` to disable specific built-in, extension, or custom tools while leaving the rest available ([#5109](https://github.com/earendil-works/pi/issues/5109)).
- Added OpenAI Codex subscription device-code login as a selectable headless alternative while keeping browser login as the default ([#4911](https://github.com/earendil-works/pi/pull/4911) by [@vegarsti](https://github.com/vegarsti)).
- Added `streamingBehavior` to extension input events so extensions can distinguish idle prompts from mid-stream steers and queued follow-ups ([#5107](https://github.com/earendil-works/pi/pull/5107) by [@DanielThomas](https://github.com/DanielThomas)).
- Added Claude Opus 4.8 model metadata for Anthropic and updated Opus adaptive-thinking coverage to use it.

### Fixed

- Fixed startup timing output so `readPipedStdin` no longer includes `createAgentSessionRuntime` work ([#4829](https://github.com/earendil-works/pi/issues/4829)).
- Fixed OpenRouter DeepSeek V4 `xhigh` reasoning metadata to preserve OpenRouter's native effort instead of sending DeepSeek's `max` effort ([#4801](https://github.com/earendil-works/pi/issues/4801)).
- Fixed custom session directories so current-folder resume/continue lookups stay scoped to the active cwd while all-session listings cover the custom directory.
- Fixed SIGTERM/SIGHUP exits to run extension `session_shutdown` cleanup and restore the terminal: signal-triggered shutdown now emits `session_shutdown` before any terminal writes, and SIGHUP no longer hard-exits, so extension resources (e.g. sockets) are released even when the terminal is gone ([#5080](https://github.com/earendil-works/pi/issues/5080)).
- Fixed keyboard protocol negotiation to ignore mismatched or delayed terminal responses, avoiding false Kitty keyboard protocol detection ([#5091](https://github.com/earendil-works/pi/pull/5091) by [@mitsuhiko](https://github.com/mitsuhiko)).
- Fixed Windows startup crashes under MSYS2 ucrt64 Node.js by updating the native clipboard addon to napi-rs 3.x ([#5028](https://github.com/earendil-works/pi/issues/5028)).
- Fixed API key and header config resolution to treat plain strings as literals, support `$ENV_VAR` / `${ENV_VAR}` interpolation and `$!` bang escaping, and require explicit env syntax for config files, avoiding Windows case-insensitive env matches corrupting literal keys ([#5095](https://github.com/earendil-works/pi/issues/5095)).
- Fixed session disposal to abort in-flight agent, compaction, branch summary, retry, and bash work ([#5029](https://github.com/earendil-works/pi/pull/5029) by [@TerminallyChilI](https://github.com/TerminallyChilI)).
- Fixed `pi.getAllTools()` to expose each tool's `promptGuidelines` for extensions that need per-tool guideline attribution ([#4879](https://github.com/earendil-works/pi/issues/4879)).
- Fixed OpenAI Codex Responses replay after switching from Anthropic extended-thinking sessions by generating unique fallback message item IDs for converted thinking/text blocks ([#5148](https://github.com/earendil-works/pi/issues/5148)).
- Fixed Anthropic-compatible replay for providers that return empty thinking signatures by adding an opt-in `allowEmptySignature` compatibility flag ([#4464](https://github.com/earendil-works/pi/issues/4464)).
- Fixed OpenAI and OpenRouter GPT-5.5 Pro thinking level metadata to expose only supported medium, high, and xhigh efforts.
- Fixed OpenCode Go Kimi K2.6 thinking-off requests to send `thinking: "none"` ([#5078](https://github.com/earendil-works/pi/issues/5078)).
- Fixed Xiaomi Token Plan model metadata to omit unsupported `mimo-v2-flash` variants ([#5075](https://github.com/earendil-works/pi/issues/5075)).
- Fixed follow-up messages queued by `agent_end` extension handlers to drain before the agent becomes idle ([#5115](https://github.com/earendil-works/pi/pull/5115) by [@DanielThomas](https://github.com/DanielThomas)).
- Fixed extension input events to report `streamingBehavior` only for prompts actually queued during streaming ([#5107](https://github.com/earendil-works/pi/pull/5107) by [@DanielThomas](https://github.com/DanielThomas)).
- Fixed system prompt tool-selection guidance to avoid preferring unavailable file exploration tools ([#5132](https://github.com/earendil-works/pi/issues/5132)).
- Fixed fenced `diff` code blocks and other highlight.js scopes to keep theme-aware syntax colors after the `cli-highlight` replacement ([#5092](https://github.com/earendil-works/pi/issues/5092)).

## 0.76.0

### New Features

- **Explicit session IDs for automation** - `--session-id <id>` lets scripts create or resume an exact project-local session. See [Sessions](docs/usage.md#sessions).
- **RPC bash output can stay out of model context** - RPC clients can pass `excludeFromContext` to `bash` for commands whose output should not be sent with the next prompt. See [RPC mode](docs/rpc.md#bash).
- **More predictable provider retries and timeouts** - Codex WebSocket/SSE waits are bounded, and `retry.provider.maxRetries` controls provider retries instead of hidden SDK defaults. See [Retry settings](docs/settings.md#retry).
- **Better terminal editing across environments** - Apple Terminal Shift+Enter, Windows/JetBrains capability detection, and Unicode-aware word navigation improve interactive editing. See [Terminal setup](docs/terminal-setup.md) and [Keybindings](docs/keybindings.md).

### Added

- Added `--session-id` to let CLI callers use an exact project-local session ID, creating it if missing ([#4874](https://github.com/earendil-works/pi/issues/4874)).
- Added `excludeFromContext` flag to the `bash` RPC command for parity with the internal `executeBash` API ([#5039](https://github.com/earendil-works/pi/issues/5039)).

### Fixed

- Fixed user message transcript rendering to preserve user-authored ordered-list markers ([#5013](https://github.com/earendil-works/pi/issues/5013)).
- Fixed self-update commands to bypass npm, pnpm, and Bun minimum release age gates for explicit `pi update` runs ([#4929](https://github.com/earendil-works/pi/issues/4929)).
- Fixed context token estimates to count user image attachments consistently with tool result images ([#4983](https://github.com/earendil-works/pi/issues/4983)).
- Fixed `httpIdleTimeoutMs` to apply to OpenAI Codex Responses WebSocket idle waits, added `websocketConnectTimeoutMs` for bounded WebSocket connect waits, and added a 10s Codex SSE response-header timeout ([#4945](https://github.com/earendil-works/pi/issues/4945)).
- Fixed `RpcClient` to reject pending requests and consume stdin pipe errors when the child process exits unexpectedly ([#4764](https://github.com/earendil-works/pi/issues/4764)).
- Fixed managed npm extension updates to avoid package managers installing or resolving pi host packages as peer dependencies ([#4907](https://github.com/earendil-works/pi/issues/4907)).
- Fixed RPC mode raw stdout writes to retry transient backpressure errors and flush queued protocol output during shutdown ([#4897](https://github.com/earendil-works/pi/issues/4897)).
- Fixed OpenAI Codex Responses cache-affinity headers to send `session-id` instead of proxy-incompatible `session_id` ([#4967](https://github.com/earendil-works/pi/issues/4967)).
- Fixed `openai-codex/gpt-5.3-codex-spark` model metadata to use its 128k context window ([#4969](https://github.com/earendil-works/pi/issues/4969)).
- Fixed OpenRouter/Poolside context overflow detection for `maximum allowed input length` errors ([#4943](https://github.com/earendil-works/pi/issues/4943)).
- Fixed provider retry controls so `retry.provider.maxRetries` is honored, SDK retries default to `0`, and quota/billing 429s are not retried behind Pi's retry handling ([#4991](https://github.com/earendil-works/pi-mono/pull/4991) by [@mitsuhiko](https://github.com/mitsuhiko)).
- Fixed Apple Terminal `Shift+Enter` by detecting local macOS modifier state when Terminal.app sends plain Return.
- Fixed Windows Terminal capability detection to enable OSC 8 hyperlinks, preserving clickable long URLs across wrapped lines ([#4923](https://github.com/earendil-works/pi/issues/4923)).
- Fixed JetBrains terminal capability detection to enable truecolor while disabling unsupported OSC 8 hyperlinks ([#5037](https://github.com/earendil-works/pi-mono/pull/5037) by [@Perlence](https://github.com/Perlence)).
- Fixed editor and input word navigation/deletion to use Unicode word boundaries while preserving ASCII punctuation boundaries ([#5022](https://github.com/earendil-works/pi-mono/pull/5022) by [@haoqixu](https://github.com/haoqixu), [#5067](https://github.com/earendil-works/pi-mono/pull/5067) by [@haoqixu](https://github.com/haoqixu), [#5068](https://github.com/earendil-works/pi-mono/pull/5068) by [@haoqixu](https://github.com/haoqixu)).
- Fixed the development docs `AGENTS.md` link to point at the pi-mono guidelines ([#5041](https://github.com/earendil-works/pi/issues/5041)).

## 0.75.5

### New Features

- **Cleaner read tool output** - Collapsed `read` tool cards now show only the read line by default, while `Ctrl+O` still expands the full file content.
- **Faster file tools on Windows** - Built-in file tools now use async filesystem operations during streaming, and image resizes run off the main TUI thread in a worker.
- **More reliable package updates** - `pi update` and git package installs now reconcile pinned git refs and keep package settings intact. See [Packages](docs/packages.md).
- **Custom Anthropic-compatible adaptive thinking** - Custom provider model configs can opt into adaptive-thinking Claude behavior with `compat.forceAdaptiveThinking`. See [Custom providers](docs/custom-provider.md) and [Models](docs/models.md).

### Added

- Added `compat.forceAdaptiveThinking` support to custom Anthropic-compatible model configuration docs and validation ([#4797](https://github.com/earendil-works/pi-mono/pull/4797) by [@mbazso](https://github.com/mbazso)).
- Added a standard unified patch to edit tool result details for SDK consumers ([#4821](https://github.com/earendil-works/pi/issues/4821)).
- Added a Codex subscription login method selector with device-code auth for headless environments.

### Changed

- Changed collapsed read tool cards to show only the read line until expanded ([#4916](https://github.com/earendil-works/pi/issues/4916)).
- Replaced the inherited optional `koffi` dependency for Windows VT input with a tiny vendored native helper, reducing install size while preserving Shift+Tab handling ([#4480](https://github.com/earendil-works/pi/issues/4480)).
- Changed the root development install documentation to use `npm install --ignore-scripts` ([#4868](https://github.com/earendil-works/pi/issues/4868)).

### Fixed

- Fixed `pi update` to reconcile git-pinned packages to their configured ref ([#4869](https://github.com/earendil-works/pi/issues/4869)).
- Fixed package/resource path handling for Windows and glob/pattern resolution ([#4873](https://github.com/earendil-works/pi-mono/pull/4873) by [@mitsuhiko](https://github.com/mitsuhiko)).
- Fixed config pattern matching to resolve patterns from the correct base directory ([#4898](https://github.com/earendil-works/pi-mono/pull/4898) by [@haoqixu](https://github.com/haoqixu)).
- Fixed theme pickers to list themes by their content name instead of file stem ([#4830](https://github.com/earendil-works/pi-mono/pull/4830) by [@Perlence](https://github.com/Perlence)).
- Fixed OpenCode Zen/Go requests to send per-session OpenCode routing headers ([#4847](https://github.com/earendil-works/pi/issues/4847)).
- Fixed Amazon Bedrock provider loading under strict package managers by inheriting the declared `@smithy/node-http-handler` dependency from `@earendil-works/pi-ai` ([#4842](https://github.com/earendil-works/pi/issues/4842)).
- Fixed inherited Amazon Bedrock Claude requests to send the model output token cap by default, avoiding Bedrock's 4096-token default truncation ([#4848](https://github.com/earendil-works/pi/issues/4848)).
- Fixed exported session HTML to escape quote characters in attribute values ([#4832](https://github.com/earendil-works/pi/issues/4832)).
- Fixed GitHub Copilot device-code login to keep opening the verification URL in browser-capable environments while ignoring browser launch failures for headless use ([#4788](https://github.com/earendil-works/pi-mono/pull/4788) by [@vegarsti](https://github.com/vegarsti)).
- Fixed git package installs to reconcile existing checkouts to the requested ref and update package settings without losing filters ([#4870](https://github.com/earendil-works/pi/issues/4870)).
- Published a 0.74.2 rescue release that tells Node 20 users to upgrade Node before updating to newer Pi versions ([#4876](https://github.com/earendil-works/pi/issues/4876)).
- Fixed final bash tool cards to avoid rendering duplicate full-output truncation paths ([#4819](https://github.com/earendil-works/pi/issues/4819)).
- Fixed bash tool truncation line counts to ignore the trailing newline as an extra output line ([#4818](https://github.com/earendil-works/pi/issues/4818)).
- Fixed footer home-directory abbreviation to avoid shortening sibling paths that only share the same prefix ([#4878](https://github.com/earendil-works/pi/issues/4878)).
- Fixed macOS Bun release binaries to resolve the native clipboard sidecar so Ctrl+V image paste can load `@mariozechner/clipboard` ([#4307](https://github.com/earendil-works/pi/issues/4307)).
- Fixed coding-agent tools to avoid synchronous filesystem operations during streaming and moved image resizing off the main TUI thread ([#4756](https://github.com/earendil-works/pi-mono/pull/4756) by [@mitsuhiko](https://github.com/mitsuhiko)).

## 0.75.4

### New Features

- **Hardened npm install and release path** - Pi now ships the CLI with a generated shrinkwrap for transitive dependencies, blocks accidental lockfile changes, verifies dependency pinning and lifecycle-script allowlists in checks, disables lifecycle scripts for self-update and local release installs where supported, and smoke-tests isolated npm and Bun installs before release. See [Supply-chain hardening](../../README.md#supply-chain-hardening).

### Added

- Added interactive update notes after `pi update` runs, so users can see the installed version's changelog before continuing ([#4724](https://github.com/earendil-works/pi-mono/pull/4724) by [@mitsuhiko](https://github.com/mitsuhiko)).
- Exported image resize utilities from the package root for SDK consumers ([#4775](https://github.com/earendil-works/pi-mono/pull/4775) by [@xl0](https://github.com/xl0)).

### Changed

- Changed source syntax to avoid TypeScript constructs that require JavaScript emit, keeping core sources compatible with Node.js strip-only TypeScript checks.
- Removed web UI workspace references from the CLI package and dropped the package-level development watch script.
- Published npm installs now include an `npm-shrinkwrap.json` to lock transitive dependencies for the CLI package.
- Improved terminal theme detection for light/dark and truecolor handling.
- Changed self-update package-manager commands to disable lifecycle scripts during reinstall.

### Fixed

- Fixed the system prompt to tell models to resolve pi docs and examples under the absolute package paths before reading topic-specific relative references ([#4752](https://github.com/earendil-works/pi/issues/4752)).
- Fixed extension `ctx.abort()` during tool-call preflight to stop later confirmations and restore queued interactive input like Escape ([#4276](https://github.com/earendil-works/pi/issues/4276)).
- Fixed AgentSession retry, compaction, and event settlement to use the awaited agent lifecycle instead of a separate event queue, and added `willRetry` to `agent_end` session events.
- Fixed forked session runtime state to keep the active session id aligned with the fork target ([#4799](https://github.com/earendil-works/pi-mono/pull/4799) by [@Perlence](https://github.com/Perlence)).
- Fixed the subagent extension's parallel mode to return useful per-task output and failed-task diagnostics to the parent model instead of 100-character previews ([#4710](https://github.com/earendil-works/pi/issues/4710)).
- Fixed Windows local bash execution to hide helper console windows when launched from background SDK processes ([#4699](https://github.com/earendil-works/pi/issues/4699)).
- Fixed managed npm extension folders to set cloud-sync ignore metadata where supported ([#4763](https://github.com/earendil-works/pi/issues/4763)).
- Fixed HTTP idle timeout configuration so long-running provider streams can avoid premature idle disconnects ([#4759](https://github.com/earendil-works/pi-mono/pull/4759) by [@mitsuhiko](https://github.com/mitsuhiko)).
- Fixed default system prompt boundaries to use explicit XML tags for clearer file separation ([#4709](https://github.com/earendil-works/pi-mono/pull/4709) by [@herrnel](https://github.com/herrnel)).
- Fixed HTML share/export sidebar clicks for shared tool entries to scroll to the rendered tool call ([#4664](https://github.com/earendil-works/pi-mono/pull/4664) by [@yzhg1983](https://github.com/yzhg1983)).
- Fixed theme palettes to set explicit text colors and avoid terminal-default color drift.
- Fixed truecolor detection to align terminal image rendering and interactive theme decisions.
- Fixed loader indicator startup inherited from `@earendil-works/pi-tui` so initialization cannot run before frames are available.
- Fixed OpenAI-compatible default output token requests inherited from `@earendil-works/pi-ai` to avoid reserving impossible context windows on servers such as vLLM ([#4675](https://github.com/earendil-works/pi/issues/4675)).
- Fixed OpenAI prompt cache keys inherited from `@earendil-works/pi-ai` to stay within the 64-character provider limit ([#4720](https://github.com/earendil-works/pi/issues/4720)).
- Fixed Windows npm-family package commands for fnm-managed Node.js installs that expose both extensionless Unix scripts and `.cmd` shims ([#4793](https://github.com/earendil-works/pi/issues/4793)).

## 0.75.3

### Fixed

- Fixed undici 8 HTTP/2 destroyed-session races crashing the Node CLI by preserving the previous HTTP/1.1-only fetch dispatcher behavior ([#4681](https://github.com/earendil-works/pi/issues/4681)).

## 0.75.2

### Fixed

- Fixed Bun-compiled release binaries failing to start when Bun's built-in undici shim lacks npm undici's `install` export ([#4661](https://github.com/earendil-works/pi-mono/pull/4661) by [@dmasiero](https://github.com/dmasiero)).
- Fixed Xiaomi MiMo generated model metadata to replay assistant tool-call messages with `reasoning_content` for thinking-mode multi-turn requests, inherited from `@earendil-works/pi-ai` ([#4678](https://github.com/earendil-works/pi/issues/4678)).
- Fixed Windows external editor handoff so vim/nvim can receive input after opening from the TUI ([#4612](https://github.com/earendil-works/pi/issues/4612)).
- Fixed Windows npm self-updates to move loaded native dependency packages out of the active install before reinstalling pi ([#4157](https://github.com/earendil-works/pi/issues/4157)).
- Fixed `pi update --self` detection for pnpm v11 global installs whose package path resolves through the pnpm store ([#4647](https://github.com/earendil-works/pi/issues/4647)).
- Fixed Windows pnpm self-updates to resolve pnpm command shims and run through pnpm instead of requiring manual updates ([#4157](https://github.com/earendil-works/pi/issues/4157)).
- Fixed Windows npm-family command execution to use cross-spawn instead of parsing `.cmd` shim internals ([#4665](https://github.com/earendil-works/pi/issues/4665)).
