# Pi upstream watch — 2026-08-07

Package: `@earendil-works/pi-coding-agent`
Checkpoint: `0.80.3`
Latest upstream: `0.84.0`

## Agent review checklist

Classify every entry below as `adapt`, `leverage`, `watch`, or `irrelevant`. Cross-reference local extension code before recommending action. Do not update `docs/upstream-watch/state.json` until the review is accepted.

Local surfaces to check first: `packages/ext/index.ts`, `packages/ext/config.ts`, `packages/ext/tools.ts`, `packages/ext/explore/`, `packages/ext/statusline.ts`, `packages/ext/notifications.ts`, `packages/ext/file-search/`, `packages/ext/inline-references/`, and docs under `README.md`.

## Upstream entries

## 0.84.0

### New Features

- **Fullscreen TUI mode** — Switch between regular and fullscreen modes at runtime, with a sticky editor and footer, independently scrollable transcript, and draggable scrollbars. See [UI & Display](docs/settings.md#ui--display).
- **Mermaid and LaTeX rendering** — Render Mermaid diagrams and terminal-friendly Unicode math in interactive transcripts. See [Markdown settings](docs/settings.md#markdown) and [TUI Markdown](../tui/README.md#markdown).
- **Per-directory context overrides** — Use `AGENTS.override.md` to replace context files for a specific directory. See [Context Files](docs/usage.md#context-files).
- **Advanced custom model sampling** — Configure arbitrary OpenAI-compatible `samplingParams` and opt-in vLLM `thinking_token_budget` values. See [Sampling Parameters](docs/models.md#sampling-parameters).
- **Baseten provider** — Use built-in Baseten authentication and model support. See [API Keys](docs/providers.md#api-keys).

### Breaking Changes

- Renamed the inherited pi-ai `ModelsStreamTransforms` interface to `ModelsRequestTransforms` because its header transformation now applies to all authenticated provider requests.
- Changed JSON and RPC `message_update` events to emit only `assistantMessageEvent` deltas, removing the cumulative `message` and `assistantMessageEvent.partial` fields that caused quadratic output growth. Clients that need partial messages must assemble deltas between `message_start` and `message_end`; the latter remains authoritative ([#7290](https://github.com/earendil-works/pi/issues/7290)).
- `ModelRegistry.getApiKeyAndHeaders()` now returns `ProviderHeaders` with `string | null` values and preserves `null` header-deletion markers. Extensions that inspect returned headers must handle `null`; extensions forwarding them to pi-ai streams should pass them through unchanged. This prevents placeholder OpenAI credentials from being sent through Cloudflare AI Gateway ([#7030](https://github.com/earendil-works/pi/issues/7030)).
- Changed `ModelRegistry.refresh()` to accept `ModelsRefreshOptions` and return `ModelsRefreshResult` instead of discarding cancellation and provider errors.
- Changed `ModelRuntime.setRuntimeApiKey()` to accept auth cancellation options rather than catalog refresh options. Call `refresh({ providers: [providerId], signal })` separately when remote freshness is required.
- Required config-form extension OAuth `refreshToken(credentials, signal)` callbacks to accept and honor a concrete abort signal.
- Replaced dynamic provider refresh context store access with the read-only `context.stored` snapshot and generation-checked `context.publish()` transaction.

  **Providers built with `createProvider({ fetchModels })`:** no catalog-publication migration is required. Before and after, return the fetched models and register the resulting provider; `createProvider()` owns restoration, persistence, and in-memory publication.

  ```ts
  // Before
  const beforeProvider = createProvider({
    // ...
    fetchModels: async ({ signal }) => {
      const response = await fetch(catalogUrl, { signal });
      return parseModels(await response.json());
    },
  });
  pi.registerProvider(beforeProvider);

  // After: unchanged
  const afterProvider = createProvider({
    // ...
    fetchModels: async ({ signal }) => {
      const response = await fetch(catalogUrl, { signal });
      return parseModels(await response.json());
    },
  });
  pi.registerProvider(afterProvider);
  ```

  **Handwritten native `Provider.refreshModels()`:** replace direct store access and pre-publication mutation with generation-guarded publications.

  ```ts
  // Before
  refreshModels: async (context) => {
    const stored = await context.store.read();
    if (stored) currentModels = stored.models;
    if (!context.allowNetwork) return;

    const refreshed = await fetchModels(context.signal);
    currentModels = refreshed;
    await context.store.write({ models: refreshed, checkedAt: Date.now() });
  },

  // After
  refreshModels: async (context) => {
    if (context.stored) {
      const restored = context.stored.models;
      if (!(await context.publish({
        update: () => { currentModels = restored; },
      }))) return;
    }
    if (!context.allowNetwork) return;

    const refreshed = await fetchModels(context.signal);
    if (context.signal.aborted) return;
    await context.publish({
      persist: { models: refreshed, checkedAt: Date.now() },
      update: () => { currentModels = refreshed; },
    });
  },
  ```

  For the config-form `pi.registerProvider(name, { refreshModels })`, callbacks that only return models remain unchanged; pi publishes the returned list. If such a callback previously used `context.store` for custom persistence, read `context.stored` and call `context.publish({ persist: entry })`. In `publish()`, omit `persist` to leave storage unchanged, pass a `ModelsStoreEntry` to write it, or pass `persist: null` to delete it.

- Replaced the inherited pi-agent-core harness session model with the v4 lane-based `Session`, `SessionStorage`, and `SessionRepo` APIs, including durable operation records, global facts, shared sequence numbers, and tree-scoped lane views.
- Promoted the inherited v2 session and `AgentHarness` API from pi-agent-core's experimental entrypoint to its default export and removed the experimental subpaths.
- Removed the inherited legacy JSONL and in-memory repository APIs. Use pi-agent-core's v4 `JsonlSessionRepo` or `InMemorySessionRepo`, both implementing the new `SessionRepo` contract.
- Added the inherited required pi-agent-core `FileSystem.renameFile()` operation for atomic JSONL publication; custom harness file-system implementations must provide same-filesystem replacement semantics ([#7707](https://github.com/earendil-works/pi/pull/7707) by [@davidbrai](https://github.com/davidbrai)).
- Replaced experimental remote-session list summaries with durable `SessionMetadata`; `RemoteSession.sessions` no longer exposes runtime phase, model, thinking, attachment, or lock state, which remains available from acquired `SessionSnapshot` values ([#7708](https://github.com/earendil-works/pi/pull/7708)).

### Added

- Added built-in Baseten provider support with `BASETEN_API_KEY` authentication and `zai-org/GLM-5.2` as the default model.
- Added experimental remote-session client APIs: the transport-neutral `PiClient`, CBOR protocol, Unix-socket transport, and `@earendil-works/pi-coding-agent/client` `RemoteSession` controller with transcript reducers. See [Pi Client](../client/README.md) and [Remote Protocol](../protocol/README.md) ([#7344](https://github.com/earendil-works/pi/pull/7344), [#7348](https://github.com/earendil-works/pi/pull/7348), [#7371](https://github.com/earendil-works/pi/pull/7371), [#7409](https://github.com/earendil-works/pi/pull/7409)).
- Added `CredentialSynchronizationError` for credential changes that commit successfully but fail to synchronize local model state.
- Added chainable `pi.registerMarkdownTransformer()` hooks for display-only transformation of user and assistant Markdown. See [`pi.registerMarkdownTransformer()`](docs/extensions.md#piregistermarkdowntransformertransformer) ([#7231](https://github.com/earendil-works/pi/pull/7231) by [@xl0](https://github.com/xl0)).
- Added an experimental fullscreen TUI mode, selectable through `--tui-mode fullscreen` or `/settings` ([#7304](https://github.com/earendil-works/pi/issues/7304)).
- Added runtime switching between regular and fullscreen TUI modes through `/settings`.
- Added a sticky editor, status, widget, and footer dock to fullscreen mode while keeping the transcript independently scrollable.
- Added a draggable transcript scrollbar to fullscreen mode with configurable `auto`, `always`, and `hidden` modes through `/settings`; `always` reserves the rightmost column.
- Added page scrolling and marked-message navigation shortcuts to fullscreen mode.
- Added an optional `scrollbarThumb` theme color for fullscreen scrollbar thumbs, falling back to `selectedBg`.
- Added configurable themed Unicode rendering for supported Mermaid diagrams in interactive messages, including optional rendering while streaming. See [Markdown settings](docs/settings.md#markdown) ([#7624](https://github.com/earendil-works/pi/pull/7624) by [@xl0](https://github.com/xl0)).
- Added opt-in `Ctrl+P`/`Ctrl+N` prompt history navigation, with explicit history bindings taking precedence over application shortcuts while the editor is focused.
- Added per-directory `AGENTS.override.md` context files, which replace `AGENTS.md` or `CLAUDE.md` in the same directory while preserving context from other directories. See [Context Files](docs/usage.md#context-files) ([#7681](https://github.com/earendil-works/pi/pull/7681) by [@Marvae](https://github.com/Marvae)).
- Added `AI_AGENT=pi` to CLI and RPC child-process environments for generic agent attribution. See [Environment Variables](README.md#environment-variables) ([#7493](https://github.com/earendil-works/pi/pull/7493) by [@renaudhartert-db](https://github.com/renaudhartert-db)).
- Added inherited terminal-friendly Unicode rendering for LaTeX expressions in Markdown. See [TUI Markdown](../tui/README.md#markdown).
- Added stacked transient notifications in fullscreen mode.
- Added arbitrary OpenAI-compatible model sampling parameters through `samplingParams` in `models.json`, model overrides, extension providers, and stream options. See [Sampling Parameters](docs/models.md#sampling-parameters) ([#7568](https://github.com/earendil-works/pi/pull/7568) by [@mrexodia](https://github.com/mrexodia)).
- Added inherited opt-in vLLM `thinking_token_budget` support for OpenAI-compatible models, reserving output tokens for the final answer ([#7638](https://github.com/earendil-works/pi/pull/7638) by [@bnsd55](https://github.com/bnsd55)).
- Added inherited support for OpenAI-compatible streams that omit `finish_reason`, using `compat.supportsFinishReason` to infer normal and tool-use stops when the stream ends. See [OpenAI Compatibility](docs/models.md#openai-compatibility).
- Added inherited deferred provider request contracts, durable response handles, authenticated fetch/cancel dispatch, and faux-provider support for pending, ready, failed, and cancelled responses ([#7339](https://github.com/earendil-works/pi/pull/7339) by [@davidbrai](https://github.com/davidbrai)).
- Added inherited vendor-neutral telemetry contracts plus agent-owned typed AI-request and harness schemas, composed span starters, and callback helpers. See the [agent telemetry schema reference](../agent/docs/telemetry-schema.md).
- Added inherited structured Amazon Bedrock failure diagnostics with HTTP status, modeled error code, and AWS request id when available ([#7286](https://github.com/earendil-works/pi/pull/7286) by [@brianstanley](https://github.com/brianstanley)).
- Added inherited `AgentOptions.shouldStopAfterTurn` for gracefully stopping after a completed turn before queued messages or another model call are processed. See [Agent Options](../agent/README.md#agent-options) ([#7367](https://github.com/earendil-works/pi/pull/7367) by [@acmerfight](https://github.com/acmerfight)).
- Added inherited v4 `JsonlSessionRepo` support for append-only JSONL harness sessions ([#7611](https://github.com/earendil-works/pi/pull/7611) by [@davidbrai](https://github.com/davidbrai)).
- Added inherited bounded branch-entry and indexed open-operation recovery queries to the v4 session API ([#7448](https://github.com/earendil-works/pi/pull/7448), [#7646](https://github.com/earendil-works/pi/pull/7646)).
- Added the inherited compile-complete `AgentHarness` v2 scaffold; unfinished operation paths reject with `HarnessNotImplemented` while durable execution is implemented.

### Changed

- Added inherited optional cancellation to pi-ai `ModelsStore` reads, writes, and deletions; catalog orchestration binds these waits to the provider refresh signal.
- Reduced the inherited default fullscreen mouse wheel step from three lines to one for finer scrolling.

### Fixed

- Fixed the footer showing `(sub)` for generic OAuth/OpenID sign-ins without a known subscription; extension OAuth providers can opt in with `isSubscription`.
- Fixed inherited OAuth token refreshes so stalled requests release the credential-store lock ([#7508](https://github.com/earendil-works/pi/issues/7508)).
- Fixed inherited tool argument validation to preserve values that already match an `anyOf`/`oneOf` union arm before coercion, avoiding nullable unions converting `null` to another primitive value ([#7328](https://github.com/earendil-works/pi/issues/7328)).
- Fixed inherited Fireworks GLM 5.2 requests sending the unsupported `prompt_cache_retention` field when long cache retention is enabled, and enabled session affinity for automatic prompt caching ([#7676](https://github.com/earendil-works/pi/issues/7676)).
- Fixed inherited `JsonlSessionRepo` enforcing session IDs globally across working directories; IDs are now unique within each working directory.
- Fixed inherited JSONL session forks and torn-tail repairs to publish atomically, avoiding partially written or corrupted sessions after interrupted writes ([#7707](https://github.com/earendil-works/pi/pull/7707) by [@davidbrai](https://github.com/davidbrai)).
- Fixed path-containing `find` globs returning no results on Windows ([#6817](https://github.com/earendil-works/pi/issues/6817)).
- Fixed messages queued during manual `/compact` failing instead of being sent after compaction completes.
- Fixed Git Bash, MSYS, Cygwin, and WSL drive paths passed to built-in file tools resolving against the current Windows drive instead of their native drive ([#7064](https://github.com/earendil-works/pi/issues/7064), [#7547](https://github.com/earendil-works/pi/issues/7547)).
- Fixed project-level nested provider retry settings replacing unmodified global provider retry settings ([#7572](https://github.com/earendil-works/pi/issues/7572)).
- Fixed inherited GitHub Copilot Grok 4.5 requests to use the supported Responses API ([#7560](https://github.com/earendil-works/pi/issues/7560)).
- Fixed fullscreen shutdown leaking terminal capability-query replies into the parent shell prompt.
- Fixed bare exact `--model` IDs shared by multiple providers choosing the first catalog entry instead of the sole authenticated provider or a clear ambiguity error ([#7327](https://github.com/earendil-works/pi/issues/7327)).
- Fixed standalone x64 binaries requiring Haswell-era AVX2/BMI2 instructions by compiling release executables against Bun's baseline runtime ([#7390](https://github.com/earendil-works/pi/pull/7390) by [@davidbrai](https://github.com/davidbrai)).
- Fixed `Ctrl+X` copy confirmations in fullscreen mode adding a transcript status line instead of showing the transient `Copied!` marker.
- Fixed Kitty image previews in fullscreen mode overlapping the sticky editor and footer dock while scrolling.
- Fixed image-heavy fullscreen sessions lagging when layout changes retransmitted visible Kitty image payloads and rendered the transcript twice per frame.
- Fixed spaces in `/settings` searches toggling the highlighted setting while typing multi-word queries such as **TUI mode** or **Quiet startup**.
- Fixed custom editors not inheriting the default editor's autocomplete dropdown item limit ([#7333](https://github.com/earendil-works/pi/issues/7333)).
- Fixed malformed resource arrays in package manifests crashing session startup ([#7187](https://github.com/earendil-works/pi/issues/7187)).
- Fixed the DOOM overlay example downloading its shareware WAD from a dead URL.
- Fixed `setToolsExpanded(false)` to be a no-op when tool output is already collapsed, avoiding redundant `Tool output: collapsed` startup notices from extensions ([#7292](https://github.com/earendil-works/pi/issues/7292)).
- Fixed extension-driven model calls in custom compaction, handoff, and Q&A examples to dispatch through the coding-agent model runtime so custom providers and resolved auth options are preserved ([#7325](https://github.com/earendil-works/pi/pull/7325)).
- Fixed long-running sessions using stale credentials after another process updates `auth.json` without serializing concurrent credential reads and delaying startup ([#7319](https://github.com/earendil-works/pi/issues/7319)).
- Fixed concurrent `models-store.json` reads forming a file-lock convoy and delaying startup.
- Updated the packaged `brace-expansion` dependency to 5.0.8 to address GHSA-mh99-v99m-4gvg ([#7316](https://github.com/earendil-works/pi/issues/7316)).
- Fixed forced model availability refreshes remaining blocked behind a stalled earlier refresh ([#7301](https://github.com/earendil-works/pi/issues/7301), [#7421](https://github.com/earendil-works/pi/pull/7421) by [@a-yeyang](https://github.com/a-yeyang)).
- Fixed `/model` catalog refresh failures to identify every catalog that failed.
- Fixed provider login remaining stuck after saving credentials when a model catalog refresh stalls by separating local credential consistency from bounded background freshness ([#7027](https://github.com/earendil-works/pi/issues/7027), [#7113](https://github.com/earendil-works/pi/issues/7113), [#7418](https://github.com/earendil-works/pi/issues/7418)).
- Fixed `/scoped-models` waiting for remote catalogs before rendering instead of showing cached models and cancelling refresh on close ([#7153](https://github.com/earendil-works/pi/issues/7153)).
- Fixed `/model <name>` waiting for catalog refresh before checking cached model matches ([#7443](https://github.com/earendil-works/pi/issues/7443)).
- Fixed stale availability snapshots and errors publishing after a newer availability pass.
- Fixed stale pi.dev, Radius, llama.cpp, and extension catalog refreshes publishing after a newer provider refresh.
- Fixed cancellation while waiting for file-backed credential or model-catalog locks, preventing cancelled mutations from running or committing later.
- Fixed concurrent in-memory credential mutations losing unrelated provider updates by serializing their read-modify-write sections.
- Updated `undici` to 8.9.0 and the packaged `brace-expansion` to 5.0.9 to address GHSA-8xcm-r25x-g524, GHSA-4cwx-7wf7-3272, GHSA-m8rv-5g2x-5cg5, GHSA-jr45-8vmc-qm54, GHSA-v3r7-h72x-cjcm, and GHSA-rgw5-rvv9-x895.
- Fixed GitHub Copilot compaction and branch summaries using the Individual endpoint instead of the credential-resolved Business or Enterprise endpoint ([#6768](https://github.com/earendil-works/pi/issues/6768)).
- Fixed extension model calls dropping credential-resolved endpoints when forwarding request authentication, including custom compaction with GitHub Copilot Business and Enterprise accounts ([#7579](https://github.com/earendil-works/pi/issues/7579)).
- Fixed fullscreen transcript navigation leaving no editor-accessible `Home`, `End`, `PageUp`, or `PageDown` variants by adding Ctrl-modified editor bindings ([#7574](https://github.com/earendil-works/pi/issues/7574)).
- Fixed extension event-bus listeners surviving session reloads and disposal ([#7656](https://github.com/earendil-works/pi/pull/7656) by [@tudoroancea](https://github.com/tudoroancea)).
- Fixed `/copy` failing to read clipboard text on Wayland when no X11 clipboard is available ([#7387](https://github.com/earendil-works/pi/pull/7387)).
- Fixed slow connections failing during the initial connection attempt by increasing the connect timeout ([#7435](https://github.com/earendil-works/pi/pull/7435) by [@muyiyr](https://github.com/muyiyr)).
- Fixed oversized images returned by extension and built-in tools bypassing automatic image resizing. See [Image settings](docs/settings.md#terminal--images) ([#7330](https://github.com/earendil-works/pi/pull/7330) by [@tizmagik](https://github.com/tizmagik)).
- Fixed session discovery missing sessions stored through symlinked directories ([#7552](https://github.com/earendil-works/pi/pull/7552) by [@muyiyr](https://github.com/muyiyr)).
- Fixed manual compaction racing with threshold auto-compaction ([#7370](https://github.com/earendil-works/pi/pull/7370) by [@davidbrai](https://github.com/davidbrai)).
- Fixed responses truncated below their intended output limit ending the run instead of compacting and retrying once ([#7540](https://github.com/earendil-works/pi/pull/7540) by [@davidbrai](https://github.com/davidbrai)).
- Fixed Git package updates leaving dependencies missing when `git clean` cannot remove an ignored dependency directory ([#7570](https://github.com/earendil-works/pi/pull/7570) by [@mrexodia](https://github.com/mrexodia)).
- Fixed `find` results from POSIX and Windows filesystem roots losing the first path segment or gaining duplicate trailing separators ([#7569](https://github.com/earendil-works/pi/pull/7569) by [@petrroll](https://github.com/petrroll)).
- Fixed transient version-check, catalog, managed-tool, and package-management HTTP failures not being retried ([#7632](https://github.com/earendil-works/pi/pull/7632) by [@petrroll](https://github.com/petrroll)).
- Fixed interactive errors ignoring the configured output padding.
- Fixed the inherited OpenCode Go provider display name.
- Fixed inherited provider error normalization treating arrays and class instances as structured response bodies instead of preserving their original errors ([#7205](https://github.com/earendil-works/pi/pull/7205) by [@erikogenvik](https://github.com/erikogenvik)).
- Fixed inherited Anthropic streams dropping text or thinking included in the initial content-block event ([#7358](https://github.com/earendil-works/pi/pull/7358) by [@davidbrai](https://github.com/davidbrai)).
- Fixed inherited Google history conversion dropping signed empty text and thinking blocks required for replay ([#7362](https://github.com/earendil-works/pi/pull/7362) by [@jingtao-wisdomgraph](https://github.com/jingtao-wisdomgraph)).
- Fixed inherited OpenAI Codex cached WebSocket sessions being shared across different account credentials ([#7364](https://github.com/earendil-works/pi/pull/7364)).
- Fixed inherited transient Google Generative AI and Vertex AI provider errors bypassing automatic retries ([#7471](https://github.com/earendil-works/pi/pull/7471) by [@vish-pr](https://github.com/vish-pr)).
- Fixed inherited Gemini 3 tool call ids being discarded during history conversion, breaking signed multi-turn replay ([#7494](https://github.com/earendil-works/pi/pull/7494) by [@muyiyr](https://github.com/muyiyr)).
- Restored inherited GitHub Copilot models returned through account-specific policy responses ([#7672](https://github.com/earendil-works/pi/pull/7672) by [@muyiyr](https://github.com/muyiyr)).
- Replaced the inherited retired Qwen Token Plan `qwen3.8-max-preview` model with `qwen3.8-max` ([#7670](https://github.com/earendil-works/pi/pull/7670) by [@QuintinShaw](https://github.com/QuintinShaw)).
- Fixed inherited terminal width accounting for Indic conjunct grapheme clusters ([#6987](https://github.com/earendil-works/pi/pull/6987) by [@petrroll](https://github.com/petrroll)).
- Fixed inherited nested fullscreen stack layouts ignoring child minimum sizes.
- Fixed inherited batched terminal color-scheme reports being parsed as one malformed response ([#7550](https://github.com/earendil-works/pi/pull/7550)).
- Fixed inherited terminal progress clearing to emit the complete OSC 9;4 sequence ([#7581](https://github.com/earendil-works/pi/pull/7581)).
- Fixed inherited iTerm2 image payloads omitting the size metadata required by the xterm.js image addon ([#7612](https://github.com/earendil-works/pi/pull/7612)).
- Fixed inherited width truncation leaving OSC 8 hyperlinks unterminated ([#7657](https://github.com/earendil-works/pi/pull/7657) by [@xXJSONDeruloXx](https://github.com/xXJSONDeruloXx)).
- Updated inherited GPT-5.6 Terra and Luna pricing across OpenAI and passthrough model catalogs.
- Fixed inherited Fireworks Kimi K3 models to use the OpenAI-compatible API with native reasoning-effort levels and deferred tools ([#7199](https://github.com/earendil-works/pi/issues/7199), [#7230](https://github.com/earendil-works/pi/pull/7230) by [@XBeg9](https://github.com/XBeg9)).
- Updated the inherited Groq Qwen reasoning override for the replacement `qwen/qwen3.6-27b` model.
- Fixed inherited Windows Shift+Enter detection by reading modifier state from the native Win32 helper.
- Fixed the inherited pi-tui npm package omitting the source and build scripts needed to rebuild its Windows and Darwin native addons.
- Fixed inherited Windows console truecolor detection when Windows Terminal does not provide `WT_SESSION` to child shells.
- Fixed inherited phantom fullscreen text selection from unmatched mouse events when changing terminal pane focus.
- Fixed inherited keyboard input rendering latency on Windows by letting input preempt the throttled render timer.
- Fixed inherited agent harness path handling on Windows for file basenames, recursive skill loading, and prompt template names.

## 0.83.0

### New Features

- **Credential export for external clients** — `pi auth print-api-key` and `pi auth print-bearer-token` export configured credentials with automatic OAuth refresh and minimum-validity enforcement.
- **Headless OpenRouter sign-in** — Complete `/login` over SSH by pasting the redirect URL or authorization code when the loopback callback is unavailable. See [OpenRouter](docs/providers.md#openrouter).
- **Claude Opus 5 on GitHub Copilot** — Use Claude Opus 5 through GitHub Copilot with adaptive thinking and a 1M context window. See [GitHub Copilot](docs/providers.md#github-copilot).

### Breaking Changes

- Upgraded bundled TypeBox aliases to 1.3.7, removing deprecated APIs including `Type.Base`, `Type.Awaited`, `Type.Promise`, `Type.AsyncIterator`, `Type.Iterator`, `Type.Options`, and `Value.Mutate`, while fixing compiled validation of nullable array tool arguments. Extensions using removed APIs must migrate to supported TypeBox APIs. See [Package Dependencies](docs/packages.md#dependencies) ([#7243](https://github.com/earendil-works/pi/pull/7243) by [@petrroll](https://github.com/petrroll)).

### Added

- Added `pi auth print-api-key` and `pi auth print-bearer-token` commands for exporting configured credentials to external clients, including automatic OAuth refresh and configurable minimum token validity ([#7168](https://github.com/earendil-works/pi/pull/7168)).
- Exposed the session's resolved model scope as `ctx.scopedModels` to extensions. See [Extension Context](docs/extensions.md#ctxmodelregistry--ctxmodel--ctxthinkinglevel--ctxscopedmodels) ([#7191](https://github.com/earendil-works/pi/pull/7191) by [@pungggi](https://github.com/pungggi), [#7215](https://github.com/earendil-works/pi/pull/7215)).
- Added inherited per-request `fetch` injection for supported text and image provider transports.
- Added the inherited `"pending"` stop reason for partial streaming messages. See [Custom Provider Stream Pattern](docs/custom-provider.md#stream-pattern) ([#7151](https://github.com/earendil-works/pi/pull/7151) by [@lucasmeijer](https://github.com/lucasmeijer)).
- Added inherited raw provider stop reasons across Google, Anthropic, Amazon Bedrock, Mistral, and OpenAI streams; unmapped terminal reasons now surface as provider errors instead of successful stops ([#7272](https://github.com/earendil-works/pi/pull/7272)).
- Added manual redirect URL and authorization-code entry to OpenRouter login for remote and headless environments. See [OpenRouter](docs/providers.md#openrouter) ([#7114](https://github.com/earendil-works/pi/pull/7114) by [@rgarcia](https://github.com/rgarcia)).
- Added inherited Claude Opus 5 support for GitHub Copilot with adaptive thinking and a 1M context window. See [GitHub Copilot](docs/providers.md#github-copilot) ([#7158](https://github.com/earendil-works/pi/pull/7158) by [@jay-aye-see-kay](https://github.com/jay-aye-see-kay)).

### Changed

- Changed inherited OAuth credential resolution to refresh tokens with less than five minutes of validity remaining instead of waiting until expiration ([#7168](https://github.com/earendil-works/pi/pull/7168)).

### Fixed

- Added a status line when the tool output expansion is toggled ([#7180](https://github.com/earendil-works/pi/issues/7180)).
- Fixed file-backed `SYSTEM.md` and `APPEND_SYSTEM.md` prompts being omitted from the interactive startup context listing. See [System Prompt Files](docs/usage.md#system-prompt-files) ([#7096](https://github.com/earendil-works/pi/issues/7096)).
- Fixed context files loading twice when a linked Git worktree is nested under its main repository. See [Context Files](docs/usage.md#context-files) ([#7221](https://github.com/earendil-works/pi/pull/7221) by [@arajkumar](https://github.com/arajkumar)).
- Fixed llama.cpp streamed responses reporting zero token usage and leaving session context accounting empty. See [llama.cpp](docs/llama-cpp.md) ([#7258](https://github.com/earendil-works/pi/pull/7258) by [@SteveImmanuel](https://github.com/SteveImmanuel)).
- Fixed session replacement and committed tree navigation during an active response to abort and persist the outgoing turn instead of leaving dangling tool calls. See [Sessions](docs/usage.md#sessions) ([#7022](https://github.com/earendil-works/pi/pull/7022) by [@tmustier](https://github.com/tmustier)).
- Fixed failed Git package installs leaving partial directories that blocked clean retries. See [Install and Manage](docs/packages.md#install-and-manage) ([#7210](https://github.com/earendil-works/pi/pull/7210) by [@haoqixu](https://github.com/haoqixu)).
- Fixed the `/model` selector retaining a stale selection while filtering instead of highlighting the top match ([#7211](https://github.com/earendil-works/pi/pull/7211) by [@christianbasch](https://github.com/christianbasch)).
- Fixed direct RPC bash commands bypassing extension `user_bash` handlers. See [User Bash Events](docs/extensions.md#user-bash-events) ([#7214](https://github.com/earendil-works/pi/pull/7214)).
- Fixed skills, prompts, and themes losing package source metadata after extensions reload resources. See [Resource Events](docs/extensions.md#resource-events) ([#6968](https://github.com/earendil-works/pi/issues/6968)).
- Fixed cancellation of concurrently running user bash commands so every active command is aborted ([#7103](https://github.com/earendil-works/pi/pull/7103) by [@yzhg1983](https://github.com/yzhg1983)).
- Fixed duplicate messages appearing when extensions switch sessions during interactive startup ([#7110](https://github.com/earendil-works/pi/pull/7110) by [@yzhg1983](https://github.com/yzhg1983)).
- Fixed inherited Qwen Token Plan reasoning models to send their service-specific thinking controls and supported reasoning-effort levels ([#6951](https://github.com/earendil-works/pi/issues/6951), [#6998](https://github.com/earendil-works/pi/issues/6998)).
- Fixed inherited Z.AI output limits being sent through an unsupported parameter. See [Providers](docs/providers.md) ([#7174](https://github.com/earendil-works/pi/pull/7174) by [@HyeokjaeLee](https://github.com/HyeokjaeLee)).
- Fixed explicitly configured Amazon Bedrock profiles being overridden by ambient AWS access keys. See [Amazon Bedrock](docs/providers.md#amazon-bedrock) ([#7176](https://github.com/earendil-works/pi/pull/7176) by [@christianbasch](https://github.com/christianbasch)).
- Fixed inherited image fallback paths overflowing narrow terminals, shortened home-directory paths, and made absolute paths clickable when terminal hyperlinks are available ([#7262](https://github.com/earendil-works/pi/pull/7262)).
- Fixed inherited OpenAI-compatible tool calls losing their function arguments when malformed deltas also contain an empty `custom` object ([#7288](https://github.com/earendil-works/pi/pull/7288) by [@sunnyyoung](https://github.com/sunnyyoung)).

## 0.82.1

### New Features

- **Claude Opus 5** — Available on Anthropic and Amazon Bedrock with adaptive thinking (including `xhigh`), inference profiles, and prompt caching. See [Providers](docs/providers.md#api-keys).
- **Anthropic gateway bearer auth** — `ANTHROPIC_AUTH_TOKEN` authenticates against Anthropic-compatible gateways that require `Authorization: Bearer`, including compaction and branch summaries. See [Environment Variables or Auth File](docs/providers.md#environment-variables-or-auth-file).
- **Faster, more resilient model catalogs** — pi.dev catalogs revalidate with `If-None-Match` so unchanged providers answer with an empty `304`, and llama.cpp models stay listed across restarts. See [llama.cpp](docs/llama-cpp.md).

### Added

- Exposed the `outputPad` setting to custom message renderers. See [Extensions](docs/extensions.md) ([#7045](https://github.com/earendil-works/pi/pull/7045) by [@xl0](https://github.com/xl0)).
- Added inherited `ANTHROPIC_AUTH_TOKEN` bearer authentication for Anthropic-compatible gateways. See [Providers](docs/providers.md#environment-variables-or-auth-file) ([#5871](https://github.com/earendil-works/pi/issues/5871)).
- Added inherited Claude Opus 5 support for Anthropic and Amazon Bedrock with adaptive thinking, inference profiles, prompt caching, and preserved AWS validation messages ([#7081](https://github.com/earendil-works/pi/pull/7081) by [@unexge](https://github.com/unexge), [#7083](https://github.com/earendil-works/pi/pull/7083) by [@davidbrai](https://github.com/davidbrai)).

### Changed

- Changed pi.dev model catalog refreshes to revalidate with `If-None-Match`, so unchanged provider catalogs answer with an empty `304` instead of a full download.
- Changed inherited Radius OAuth device authorization, token exchange, and refresh requests to use the configured gateway directly.
- Changed inherited model loading errors to append the underlying cause, so auth failures such as `OAuth refresh failed for openai-codex` report the provider response instead of a bare wrapper message.

### Fixed

- Fixed compaction and branch summaries for providers whose authentication resolves entirely to request headers ([#5871](https://github.com/earendil-works/pi/issues/5871))
- Fixed unavailable scoped models being hidden from `/models`, allowing them to be removed without editing settings manually ([#6949](https://github.com/earendil-works/pi/issues/6949), [#7032](https://github.com/earendil-works/pi/pull/7032) by [@christianklotz](https://github.com/christianklotz)).
- Fixed startup context file discovery to skip directories that match context file names such as `AGENTS.md`, which produced `EISDIR` warnings ([#7106](https://github.com/earendil-works/pi/pull/7106) by [@mrexodia](https://github.com/mrexodia)).
- Fixed the llama.cpp extension to persist its model catalog, so llama.cpp models stay listed before the first successful refresh. See [llama.cpp](docs/llama-cpp.md) ([#7072](https://github.com/earendil-works/pi/pull/7072) by [@davidbrai](https://github.com/davidbrai)).

## 0.82.0

### New Features

- **Constrained tool sampling** — Tools can prefer or require strict JSON Schema sampling or use OpenAI Lark/regex grammars, with model capability metadata preventing unsupported requests. See [Constrained Sampling for Tools](../ai/README.md#constrained-sampling-for-tools).
- **OpenRouter and Kimi Code sign-in** — Use `/login` to authorize OpenRouter or a Kimi Code subscription without manually configuring API keys. See [OpenRouter](docs/providers.md#openrouter).
- **Session-aware, streaming bash integrations** — Bash tools receive current session/model metadata, while direct RPC bash commands stream correlated output. See [Bash Tool Session Environment](docs/environment-variables.md#bash-tool-session-environment) and [RPC bash events](docs/rpc.md#bash_execution_update).

### Added

- Added inherited `Tool.constrainedSampling` with strict JSON Schema (`prefer`/`require`) and OpenAI Lark/regex grammar variants across OpenAI, Anthropic, Amazon Bedrock, Google Gemini, and Mistral. See [Constrained Sampling for Tools](../ai/README.md#constrained-sampling-for-tools).
- Added inherited `supportsGrammarTools` and `supportsStrictTools` compatibility flags, expanded `supportsStrictMode` coverage, and generated model capability metadata to gate constrained sampling.
- Added inherited Kimi Code subscription OAuth login for the Kimi For Coding provider, including device authorization and automatic token refresh ([#6935](https://github.com/earendil-works/pi/pull/6935) by [@zaycruz](https://github.com/zaycruz)).
- Added inherited OpenRouter OAuth PKCE login through `/login`, minting a user-controlled API key. See [OpenRouter](docs/providers.md#openrouter) ([#6927](https://github.com/earendil-works/pi/pull/6927) by [@rsaryev](https://github.com/rsaryev)).
- Exposed `PI_SESSION_ID`, `PI_SESSION_FILE`, `PI_PROVIDER`, `PI_MODEL`, and `PI_REASONING_LEVEL` to commands run by built-in and factory-created bash tools. See [Bash Tool Session Environment](docs/environment-variables.md#bash-tool-session-environment).
- Added streaming `bash_execution_update` events for direct RPC bash commands, correlated with request IDs. See [RPC bash events](docs/rpc.md#bash_execution_update) ([#6971](https://github.com/earendil-works/pi/pull/6971) by [@ananthakumaran](https://github.com/ananthakumaran)).

### Changed

- Changed inherited generated model catalogs to expose only provider-verified reasoning effort levels from models.dev ([#6928](https://github.com/earendil-works/pi/pull/6928) by [@davidbrai](https://github.com/davidbrai)).

### Fixed

- Fixed inherited DNS lookup failures such as `getaddrinfo`, `ENOTFOUND`, and `EAI_AGAIN` to trigger automatic assistant retries ([#6946](https://github.com/earendil-works/pi/pull/6946) by [@christianklotz](https://github.com/christianklotz)).
- Fixed inherited OpenRouter Anthropic cache breakpoints to advance through tool results and enabled cache control for `~anthropic/*-latest` aliases ([#6941](https://github.com/earendil-works/pi/pull/6941) by [@mteam88](https://github.com/mteam88)).
- Fixed inherited OpenAI Codex WebSocket sessions to retry once without a missing previous-response continuation after `previous_response_not_found` errors ([#6955](https://github.com/earendil-works/pi/pull/6955) by [@davidbrai](https://github.com/davidbrai)).
- Fixed TUI debug and crash logs to respect custom agent directories instead of always writing under `~/.pi/agent` ([#6958](https://github.com/earendil-works/pi/pull/6958) by [@davidbrai](https://github.com/davidbrai)).
- Fixed slow Ctrl+G external-editor startup when the system temporary directory contains many entries ([#6903](https://github.com/earendil-works/pi/pull/6903) by [@christianklotz](https://github.com/christianklotz)).
- Fixed startup resource display to preserve relative paths for sibling npm extensions loaded by a package ([#6964](https://github.com/earendil-works/pi/pull/6964) by [@davidbrai](https://github.com/davidbrai)).
- Fixed compaction and branch-summary requests to use fresh routing session IDs with prompt caching disabled where supported ([#6618](https://github.com/earendil-works/pi/pull/6618) by [@tmustier](https://github.com/tmustier)).
- Fixed explicit self-updates when `PI_SKIP_VERSION_CHECK` is set ([#6977](https://github.com/earendil-works/pi/issues/6977)).
- Fixed scoped model IDs containing brackets to resolve as literal exact matches before glob matching ([#6210](https://github.com/earendil-works/pi/issues/6210)).
- Fixed inherited OpenAI and Anthropic provider retry waits to honor abort signals and configured delay limits ([#6980](https://github.com/earendil-works/pi/pull/6980) by [@petrroll](https://github.com/petrroll)).
- Fixed fresh installs from preferring bundled model catalogs over newer remote catalogs because package file mtimes were newer ([#7016](https://github.com/earendil-works/pi/pull/7016) by [@davidbrai](https://github.com/davidbrai)).
- Fixed inherited editor scroll indicators overflowing narrow terminals ([#7015](https://github.com/earendil-works/pi/pull/7015) by [@christianklotz](https://github.com/christianklotz)).
- Fixed llama.cpp models to use the loaded context window as their output token limit instead of capping it at 16K ([#7034](https://github.com/earendil-works/pi/pull/7034) by [@christianklotz](https://github.com/christianklotz)).
- Fixed release source archives to include the generated provider model data used to build standalone binaries.
- Updated the packaged `protobufjs` dependency to 7.6.5 to address GHSA-j3f2-48v5-ccww ([#7005](https://github.com/earendil-works/pi/issues/7005)).
- Fixed `/copy` on Wayland to fall back to X11 or OSC 52 when `wl-copy` fails ([#7009](https://github.com/earendil-works/pi/pull/7009) by [@rkfshakti](https://github.com/rkfshakti)).
- Fixed `/model` to reload updated `models.json` configuration when opening the model picker ([#6999](https://github.com/earendil-works/pi/issues/6999)).

## 0.81.1

### New Features

- **Verifiable release source archives** — GitHub releases now include deterministic, checksummed source archives with instructions for rebuilding standalone binaries. See [Building standalone binaries from release source](../../README.md#building-standalone-binaries-from-release-source).
- **Resilient compaction and branch summaries** — Transient provider failures now follow the configured retry policy, with retry lifecycle events available to interactive, JSON, RPC, and SDK consumers. See [Compaction & Branch Summarization](docs/compaction.md) and [RPC retry events](docs/rpc.md#summarization_retry_scheduled--summarization_retry_attempt_start--summarization_retry_finished).

### Added

- Added deterministic, checksummed source archives to GitHub releases with documented standalone binary rebuild instructions ([#6913](https://github.com/earendil-works/pi/pull/6913) by [@christianklotz](https://github.com/christianklotz)).

### Fixed

- Fixed compaction and branch summarization to retry transient provider failures using the configured retry policy, with retry lifecycle events exposed to interactive, JSON, RPC, and SDK consumers ([#6901](https://github.com/earendil-works/pi/pull/6901) by [@davidbrai](https://github.com/davidbrai)).
- Fixed interactive startup waiting for background model catalog refresh while computing the footer provider count.
- Restored the default stream fallback for extensions using the pre-0.81 agent-core API ([#6915](https://github.com/earendil-works/pi/issues/6915)).
- Fixed inherited Kimi K3 models from Moonshot AI and Moonshot AI China to use the OpenAI thinking format and expose reasoning effort support.

## 0.81.0

### New Features

- **Local llama.cpp model management** — Connect to a llama.cpp router, search and download Hugging Face models, and explicitly load or unload models with live progress. See [llama.cpp](docs/llama-cpp.md).
- **Full provider extensions** — Extensions can register complete pi-ai providers with authentication, model refresh, filtering, and custom streaming. See [Register New Provider](docs/custom-provider.md#register-new-provider).
- **Qwen Token Plan providers** — Use the built-in international and China subscription providers with regional endpoints and API-key authentication. See [API Keys](docs/providers.md#api-keys).
- **Expanded usage accounting** — Tool, compaction, and branch-summary usage is persisted and included in session totals. See [Compaction & Branch Summarization](docs/compaction.md).

### Added

- Added Qwen Token Plan and Qwen Token Plan China to built-in provider setup, default model resolution, and provider documentation ([#6858](https://github.com/earendil-works/pi/pull/6858) by [@QuintinShaw](https://github.com/QuintinShaw)).
- Added the `get_available_thinking_levels` RPC command and `RpcClient.getAvailableThinkingLevels()` method ([#6865](https://github.com/earendil-works/pi/pull/6865) by [@cristinaponcela](https://github.com/cristinaponcela)).
- Exported message and tool execution lifecycle event types from the package root ([#6772](https://github.com/earendil-works/pi/pull/6772) by [@davidbrai](https://github.com/davidbrai)).
- Added built-in llama.cpp router support with `/login` connection setup and `/llama` Hugging Face model search and downloads, explicit loading, unloading, and live progress. See [llama.cpp](docs/llama-cpp.md).
- Added extension registration for complete pi-ai providers, including native authentication, model refresh, filtering, and streaming behavior.
- Added usage accounting for tools, compaction, and branch summaries in persisted sessions, footer totals, and session statistics ([#6671](https://github.com/earendil-works/pi/pull/6671) by [@davidbrai](https://github.com/davidbrai)).

### Fixed

- Updated the packaged `brace-expansion` dependency to 5.0.7 ([#6896](https://github.com/earendil-works/pi/pull/6896) by [@davidbrai](https://github.com/davidbrai)).
- Fixed persisted remote model catalogs from overriding newer bundled catalogs after an upgrade.
- Fixed inherited stored API-key credentials to apply their provider-scoped `env` values, including Amazon Bedrock profiles ([#6864](https://github.com/earendil-works/pi/pull/6864) by [@cristinaponcela](https://github.com/cristinaponcela)).
- Fixed inherited OpenAI-compatible cross-provider replay to keep tool call IDs unique when multiple calls share a provider call ID ([#6854](https://github.com/earendil-works/pi/pull/6854) by [@cristinaponcela](https://github.com/cristinaponcela)).
- Fixed inherited Kimi K3 thinking levels to expose low, high, and max, and normalized the `k2p7` alias to `kimi-for-coding`.
- Fixed inherited OpenCode Go models routed through the OpenAI Responses API.
- Fixed inherited `pi-ai` package metadata to avoid repeated consumer lockfile changes ([#6812](https://github.com/earendil-works/pi/pull/6812) by [@jmfederico](https://github.com/jmfederico)).
- Fixed inherited terminal shutdown to clear the editor's inverted software cursor before restoring the hardware cursor ([#6790](https://github.com/earendil-works/pi/pull/6790) by [@dam9000](https://github.com/dam9000)).
- Fixed inherited ANSI-aware text wrapping to recognize CRLF and CR line endings while preserving styles ([#6764](https://github.com/earendil-works/pi/pull/6764) by [@xz-dev](https://github.com/xz-dev)).
- Fixed inherited editor paste registry corruption after deleting and undoing paste markers, preventing literal or mismatched paste markers in submitted prompts ([#6844](https://github.com/earendil-works/pi/issues/6844)).
- Fixed sessionless OpenAI Codex WebSocket requests to use UUIDv7 request IDs ([#6834](https://github.com/earendil-works/pi/pull/6834) by [@xl0](https://github.com/xl0)).
- Fixed inherited GPT-5.6 Codex models to default to the 272K context window, avoiding automatic long-context pricing ([#6853](https://github.com/earendil-works/pi/pull/6853) by [@aadishv](https://github.com/aadishv)).
- Fixed messages queued during compaction to preserve steering and follow-up delivery behavior ([#6730](https://github.com/earendil-works/pi/pull/6730) by [@dannote](https://github.com/dannote)).
- Fixed read tool errors being syntax-highlighted as if they were file contents ([#6731](https://github.com/earendil-works/pi/pull/6731) by [@dannote](https://github.com/dannote)).
- Fixed llama.cpp router download progress updates and removed redundant wording from model action confirmations.
- Moved automatic model catalog network refresh out of startup initialization and into the running interactive and RPC modes.
- Fixed persisted sessions being read and parsed twice when opened, reducing startup latency for large sessions ([#6793](https://github.com/earendil-works/pi/issues/6793)).
- Fixed prompt-template defaults for all arguments (`${@:-default}` and `${ARGUMENTS:-default}`) ([#6695](https://github.com/earendil-works/pi/issues/6695)).
- Fixed obsolete custom UI, custom tool, and custom editor examples in the extension documentation ([#6735](https://github.com/earendil-works/pi/issues/6735)).
- Fixed Kimi Coding sessions to show API-equivalent implied costs with the subscription indicator.
- Fixed OpenAI Responses early stream endings to trigger automatic retry instead of ending the agent run ([#6727](https://github.com/earendil-works/pi/issues/6727)).

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
