# Pi upstream watch — 2026-10-25

Package: `@earendil-works/pi-coding-agent`
Checkpoint: `1.0.0`
Latest upstream: `1.4.0`

## Agent review checklist

Classify every entry below as `adapt`, `leverage`, `watch`, or `irrelevant`. Cross-reference local extension code before recommending action. Do not update `docs/upstream-watch/state.json` until the review is accepted.

Local surfaces to check first: `packages/ext/index.ts`, `packages/ext/config.ts`, `packages/ext/tools.ts`, `packages/ext/subagents/`, `packages/ext/statusline.ts`, `packages/ext/notifications.ts`, `packages/ext/file-search/`, `packages/ext/inline-references/`, and docs under `README.md`.

## Upstream entries

## 1.4.0

### New Features

- **Image input for classifiers**: codemode `models.classify()` accepts `images` for TypeSafe's Jev and Cloudflare's Clef models on `typesafe`, `cloudflare-workers-ai`, and OpenRouter. See [Use classifier models](docs/models.md#use-classifier-models) and [Codemode](docs/codemode.md#models).
- **Models Configuration reference**: every provider, model, model override, and compatibility field of `models.json`, generated from its schema. See [Models Configuration](docs/models-configuration.md).
- **Summaries without a fixed output cap**: compaction and branch summaries use the model's output limit, so long reasoning no longer makes them fail. See [Compaction](docs/compaction.md#compaction).
- **Codemode waits for a free worker**: parallel scripts and in-process subagents queue instead of failing, and `PI_CODEMODE_MAX_WORKERS` raises the limit. See [Codemode limits](docs/codemode.md#limits).
- **Rex terminal support**: OSC 8 hyperlinks, truecolor, and inline images.

### Added

- Added a Models Configuration reference generated from the `models.json` schema, listing all provider, model, model override, and compatibility fields ([#10790](https://github.com/earendil-works/pi/issues/10790))
- Codemode `models.classify()` now accepts `images` for TypeSafe's Jev and Cloudflare's Clef models on `typesafe`, `cloudflare-workers-ai`, and OpenRouter, and lists Clef Omni and Jev 1.14 on Workers AI.
- Provider-level `compat` in `models.json` now also applies to classifier models, with the System One fields `imageInput` and `sendImageOptInHeader` for proxies that serve another service's classifiers. Extension classifier models accept `compat` too.
- Added `MiniMax-M3.1-Flash` to the `minimax` and `minimax-cn` providers, with thinking levels low through max ([#11121](https://github.com/earendil-works/pi/issues/11121))
- Added support for the Rex terminal: OSC 8 hyperlinks, truecolor, and inline images ([#11131](https://github.com/earendil-works/pi/issues/11131), [#11150](https://github.com/earendil-works/pi/pull/11150) by [@petrroll](https://github.com/petrroll), [#11183](https://github.com/earendil-works/pi/pull/11183) by [@nihaals](https://github.com/nihaals))

### Changed

- Provider attribution headers now come from pi-ai's client identity. Extensions' `before_provider_headers` handlers no longer see the OpenRouter, NVIDIA NIM, and OpenCode attribution headers; returning `null` for one still removes it. Cloudflare requests send pi's detailed `User-Agent` instead of `pi-coding-agent`, as do GitHub release checks for tool downloads, and OpenCode requests send `x-opencode-client` whenever attribution is enabled, not only with a session.
- `generateSummary()` and `generateSummaryWithUsage()` now ignore their `reserveTokens` parameter. Summary requests use the model's output limit instead.
- Changed the default GitHub Copilot model from `gpt-5.4`, which Copilot retired, to `gpt-6.1-sol`.
- Changed the default NVIDIA model to `nvidia/nemotron-3.5-super-vl-120b-a12b` ([#10910](https://github.com/earendil-works/pi/pull/10910) by [@cv](https://github.com/cv))
- Changed the default Xiaomi model to `mimo-v2.6-pro` for the `xiaomi` and Xiaomi Token Plan providers, since `mimo-v2.5-pro` left the catalog.
- Grok 4.3 and Grok 4.5 on the `xai` provider now offer the `xhigh` thinking level.
- Sign in with ChatGPT: ChatGPT Business workspace usage-limit errors are not retried and tell the user to ask their workspace admin to increase the limit.

### Fixed

- Fixed compaction and branch summaries failing with "generation hit the token cap" when reasoning used most of the fixed summary output limit. Summaries now use the model's output limit, and `compaction.reserveTokens` only controls when compaction starts ([#9512](https://github.com/earendil-works/pi/issues/9512), [#9075](https://github.com/earendil-works/pi/issues/9075)).
- Fixed `models.schema.json` missing descriptions for provider and model fields, so editors showed no hints for them ([#10790](https://github.com/earendil-works/pi/issues/10790))
- Fixed `pi update` failing with "Managed install marker is missing or invalid" when `managed-install.json` starts with a UTF-8 BOM, which Windows PowerShell 5.1 adds when it rewrites the file.
- Fixed HTML export showing literal asterisks for Markdown bold and italic next to CJK punctuation ([#3353](https://github.com/earendil-works/pi/issues/3353), [#10154](https://github.com/earendil-works/pi/issues/10154))
- Fixed the terminal staying in mouse-tracking, focus-reporting, Kitty keyboard, and alternate-screen modes when pi exits without its normal terminal teardown, which flooded the shell prompt with escape sequences ([#11170](https://github.com/earendil-works/pi/issues/11170))
- Fixed concurrent extension `select`/`confirm`/`input`/`editor` dialogs and inline `custom()` components in interactive mode: a second dialog replaced the first and the first promise never settled; closing the visible dialog now shows the previous one again ([#11166](https://github.com/earendil-works/pi/issues/11166), [#9909](https://github.com/earendil-works/pi/issues/9909))
- Fixed pasting in the shell hanging after copying text in pi and suspending it with Ctrl+Z on Linux: the background `wl-copy`/`xclip`/`xsel` process that keeps serving the clipboard was suspended along with pi ([#11179](https://github.com/earendil-works/pi/issues/11179))
- Fixed codemode scripts failing immediately when both codemode workers are busy, for example with parallel codemode calls or in-process subagents. Scripts now wait up to 60 seconds for a free worker, and `PI_CODEMODE_MAX_WORKERS` raises the limit of two workers ([#11184](https://github.com/earendil-works/pi/issues/11184))
- Fixed extensions failing to load when importing `@earendil-works/pi-ai/models` (e.g. for `clampThinkingLevel`) by exposing the subpath through the extension loader aliases and virtual modules ([#11156](https://github.com/earendil-works/pi/issues/11156))
- Fixed `mcp.json` files that start with a UTF-8 BOM failing to parse, which skipped all their MCP servers and made `pi mcp add`/`pi mcp remove` fail ([#11191](https://github.com/earendil-works/pi/issues/11191))
- Fixed `/compact <instructions>` ignoring the instructions when summarizing the start of a turn that compaction splits. When the split turn was the only new content since the last compaction, the instructions were ignored entirely ([#11058](https://github.com/earendil-works/pi/issues/11058))
- Fixed resumed sessions and `/tree` navigation leaving extension tools inactive when the branch recorded its tools before they were registered, such as tools from extensions installed after the session started. Extension tools the branch never added or removed are now active unless they are registered with `defaultActive: false` ([#11062](https://github.com/earendil-works/pi/issues/11062), [#11075](https://github.com/earendil-works/pi/issues/11075))
- Fixed sessions breaking after recovery from a response cut off at the output limit: the truncated tool call was omitted but its tool results were kept, so providers rejected every later request ([#11227](https://github.com/earendil-works/pi/issues/11227), [#11233](https://github.com/earendil-works/pi/pull/11233) by [@petrroll](https://github.com/petrroll))
- Fixed the `grep` tool following `RIPGREP_CONFIG_PATH`, where options such as `--fixed-strings` silently changed regex searches into literal ones. The tool now runs `rg --no-config` ([#11203](https://github.com/earendil-works/pi/issues/11203), [#11230](https://github.com/earendil-works/pi/pull/11230) by [@petrroll](https://github.com/petrroll))
- Fixed Windows shell detection rejecting runnable Microsoft Store shell aliases ([#9504](https://github.com/earendil-works/pi/pull/9504) by [@petrroll](https://github.com/petrroll))
- Fixed Windows shell detection missing PowerShell outside `PATH` and the legacy WSL `bash.exe` launcher when Windows is not installed in `C:\Windows`. pi now checks `%ProgramFiles%\PowerShell\7`, `%SystemRoot%\System32\WindowsPowerShell\v1.0`, and `%SystemRoot%` ([#9501](https://github.com/earendil-works/pi/pull/9501) by [@petrroll](https://github.com/petrroll))
- Fixed GitHub Copilot sessions with large request bodies, such as many images, failing with HTTP 413 `failed to parse request` instead of compacting and retrying ([#11016](https://github.com/earendil-works/pi/pull/11016) by [@petrroll](https://github.com/petrroll))
- Fixed the `openai-codex` provider offering `gpt-5.5` and `gpt-5.3-codex-spark`, which always fail for ChatGPT accounts ([#11173](https://github.com/earendil-works/pi/pull/11173) by [@lucasmeijer](https://github.com/lucasmeijer))
- Fixed whitespace-only tool output (for example a bare `\r\n` from bash) making OpenAI Completions, OpenAI Responses, and Google requests fail with a 400 ([#8720](https://github.com/earendil-works/pi/issues/8720))
- Fixed automatic retry not triggering for more gateway upstream failures, `stream disconnected before completion` errors relayed by Codex CLI proxies, and transient Google Vertex OAuth token refresh failures, and retrying errors because of digits inside request ids or byte counts ([#10920](https://github.com/earendil-works/pi/issues/10920), [#11057](https://github.com/earendil-works/pi/issues/11057), [#10996](https://github.com/earendil-works/pi/issues/10996))
- Fixed OpenAI Responses models losing the prompt cache on every deferred tool load after a tool was removed ([#10940](https://github.com/earendil-works/pi/issues/10940))
- Fixed Cloudflare Workers AI classifier pricing: Clef Flash costs $0.038 and Jev $0.042 per million input tokens instead of Jev being listed as free.
- Fixed an unclosed `$$` display-math block swallowing or corrupting every Markdown table after it ([#11159](https://github.com/earendil-works/pi/issues/11159))
- Fixed Markdown bold and italic not rendering next to CJK punctuation ([#10730](https://github.com/earendil-works/pi/pull/10730) by [@theBucky](https://github.com/theBucky))
- Fixed `@` file autocomplete returning no results for queries containing regex metacharacters such as `[` or `(` ([#10972](https://github.com/earendil-works/pi/issues/10972))

## 1.3.0

### New Features

- **Choose where `/share` uploads**: `sessionShareDestination` selects `auto`, `gist`, or `radius`. See [Sessions and context](docs/settings.md#sessions-and-context) and [Export or share a session](docs/sessions.md#export-or-share-a-session).
- **Cache-preserving thinking level changes on OpenAI GPT-6**: changing the thinking level mid-session with an API key keeps the prompt cache.
- **Kimi Code over Chat Completions**: tools added mid-conversation no longer invalidate the prompt cache. `models.json` base URL overrides must now include `/v1`. See [Providers](docs/providers.md).
- **Clean model switching**: thinking from a previous model is dropped instead of being shown to the new model as text.
- **Resumed sessions keep their active tools**: `--tools +name`/`-name` applies on top of them. See [Tools](docs/settings.md#tools).

### Added

- Changing the thinking level mid-session on OpenAI GPT-6 models (API key) now keeps the prompt cache ([#10853](https://github.com/earendil-works/pi/issues/10853))
- Added the `sessionShareDestination` setting to choose automatic, GitHub gist, or Radius uploads for `/share` ([#10870](https://github.com/earendil-works/pi/issues/10870) by [@vegarsti](https://github.com/vegarsti))

### Changed

- Changed the `kimi-coding` provider to use OpenAI Chat Completions at `https://api.kimi.com/coding/v1`, the protocol used by the official Kimi Code client. K3, K3-256K, and Kimi For Coding now accept tools added mid-conversation without invalidating the prompt cache. `models.json` overrides of the `kimi-coding` base URL must now include `/v1` ([#10720](https://github.com/earendil-works/pi/issues/10720))
- Changed model switching to drop thinking blocks from earlier assistant messages produced by a different model, instead of sending them as plain text. The new model previously saw the old model's reasoning as part of its replies and could start writing its own reasoning into the visible answer ([#10995](https://github.com/earendil-works/pi/issues/10995))

### Fixed

- Pinned internal Pi dependencies to exact release versions to prevent fresh installs from mixing incompatible packages ([#10865](https://github.com/earendil-works/pi/issues/10865))
- Fixed resumed sessions dropping tools activated during the session. Resume now restores the session's active tools, with `--tools +name`/`-name` entries applied to them, unless `--tools` with tool names, `--no-tools`, or `--no-builtin-tools` selects tools explicitly ([#10785](https://github.com/earendil-works/pi/issues/10785))
- Fixed stopping a codemode script or reaching its deadline waiting for a non-interruptible built-in to return on Bun ([#10748](https://github.com/earendil-works/pi/issues/10748))
- Fixed repeated codemode timeouts or aborts accumulating surviving workers; admission now limits live workers to two across sessions, counting cancelled workers until actual exit ([#10748](https://github.com/earendil-works/pi/issues/10748))
- Fixed `--model` choosing a provider by catalog order when several providers offer the match; Pi now prefers the provider with credentials and otherwise reports the ambiguity. `--models` and `enabledModels` add a model for each provider that offers it and warn about the ambiguity ([#10160](https://github.com/earendil-works/pi/issues/10160))
- Fixed `read` line-range labels for numeric-string or null arguments in the TUI, session tree, HTML exports, and examples ([#9887](https://github.com/earendil-works/pi/issues/9887))
- Fixed the Nix flake build failing when a provider switched APIs: the model catalog pin is now refreshed from the newest published catalog when its model API groups differ, and releases pin the newest catalog and build with it before tagging ([#10985](https://github.com/earendil-works/pi/issues/10985))
- Fixed the Nix package putting its Node.js first on `PATH`, which made bash tool shells use Pi's Node instead of the user's `node`/`npm`. Pi's Node is now only a fallback ([#10519](https://github.com/earendil-works/pi/issues/10519))
- Fixed prompt templates dropping empty quoted arguments (`""` or `''`), which shifted later positional arguments and prevented positional defaults from applying ([#10867](https://github.com/earendil-works/pi/issues/10867))
- Fixed the Nix package build failing in its install check because it still expected chord and esbuild, which Pi no longer depends on
- Fixed tool-call argument parsing dropping fields when a string contains an invalid `\u` escape such as `\usepackage` ([#10868](https://github.com/earendil-works/pi/issues/10868))
- Fixed Anthropic and Bedrock Claude requests failing with a 400 when an error tool result contains images; the images are now sent after the tool results of the turn, so the model still sees them ([#10794](https://github.com/earendil-works/pi/issues/10794))
- Fixed OpenCode Go Gemini models failing with a 404 by moving OpenCode Zen and OpenCode Go to the `opencode.ai/inference` endpoints, and added Google Generative AI support to the OpenCode Go provider
- Fixed OpenCode Go MiniMax M2.7 failing with "Model does not support this protocol" by using the Anthropic Messages API
- Fixed automatic retry not triggering for gateway `Unable to forward upstream stream` errors ([#10920](https://github.com/earendil-works/pi/issues/10920))
- Fixed automatic retry not triggering for `The service is temporarily unavailable` errors, which also made compaction fail on the first attempt ([#10965](https://github.com/earendil-works/pi/issues/10965))
- Fixed OpenAI-compatible responses showing thinking after the answer when a proxy such as LiteLLM sends reasoning and content in the same stream chunk ([#10926](https://github.com/earendil-works/pi/issues/10926))
- Fixed Gemini 4 Argon requests on Google Vertex failing with "Thinking budget is not supported", and its thinking level being ignored on the Gemini API ([#10890](https://github.com/earendil-works/pi/issues/10890))
- Fixed Xiaomi MiMo models failing with a 400 at the `minimal` thinking level; they now expose only the `off` and `high` levels ([#10818](https://github.com/earendil-works/pi/issues/10818))
- Fixed `openai-codex/gpt-6.1-sol` using a 272K context window instead of the 500K window Codex now provides ([#10840](https://github.com/earendil-works/pi/issues/10840))
- Fixed tool calls whose final arguments are malformed JSON silently running with only the fields parsed before the error; they now fail validation and show the model the raw arguments it sent ([#10897](https://github.com/earendil-works/pi/issues/10897))
- Fixed Claude Haiku 5.5 and Claude Opus 5 not supporting the `off` thinking level ([#10753](https://github.com/earendil-works/pi/issues/10753))
- Fixed `done()` of an extension's `ctx.ui.custom({ overlay: true })` closing the topmost overlay instead of its own, which left the finished overlay on screen and another extension's dialog unresolved ([#10648](https://github.com/earendil-works/pi/issues/10648), [#10999](https://github.com/earendil-works/pi/pull/10999) by [@masonc15](https://github.com/masonc15))

## 1.2.0

### New Features

- **Per-key OpenRouter model lists**: with an OpenRouter key, Pi lists only the models that key may use, with the key's context size, max output, and prices, including regional endpoints set in `models.json`. See [OpenRouter](docs/providers.md#openrouter).
- **Published configuration schemas**: add `$schema` to `settings.json`, `models.json`, keybindings, and themes for editor validation and completion. See [Settings](docs/settings.md), [Models](docs/models.md), [Keybindings](docs/keybindings.md), and [Themes](docs/themes.md).
- **Clipboard copies over remote sessions**: `PI_CLIPBOARD_OSC52=1` sends copied text to a remote client's clipboard when Pi cannot detect the remote session, such as a multiplexer attached from another machine. See [Pi Process Configuration](docs/environment-variables.md#pi-process-configuration).
- **Codemode improvements**: tool declarations show input constraints such as integer, minimum/maximum, and default, and codemode rows show elapsed and total time. See [Codemode](docs/codemode.md).
- **`before_agent_start` for extension-triggered runs**: runs started by `pi.sendMessage(..., { triggerTurn: true })` go through the same setup as prompts. See [Events and concurrency](docs/extensions.md#events-and-concurrency).

### Breaking Changes

- Published generated configuration schemas for models, settings, keybindings, and themes at `https://pi.dev/schemas/*.schema.json`. The theme schema moved to `https://pi.dev/schemas/theme.schema.json`; themes loaded during startup now receive the same schema validation as later reloads. Update theme `$schema` references, define reusable colors under `vars`, and remove unsupported metadata ([#9880](https://github.com/earendil-works/pi/pull/9880), [#10751](https://github.com/earendil-works/pi/pull/10751) by [@christianklotz](https://github.com/christianklotz))
- Changed `before_agent_start` to also fire for runs started by `pi.sendMessage(..., { triggerTurn: true })` while idle. `BeforeAgentStartEvent` is now a union on `messageType`: `"user"` events carry `prompt` and `images`, and `"custom"` events carry the starting `message` and no `prompt`. Messages returned by handlers are added to both kinds of run, and pending `deliverAs: "nextTurn"` messages are delivered with the custom-message run. Handlers that should act only on user prompts must check `event.messageType === "user"` ([#10267](https://github.com/earendil-works/pi/issues/10267), [#5581](https://github.com/earendil-works/pi/issues/5581), [#10739](https://github.com/earendil-works/pi/pull/10739) by [@davidbrai](https://github.com/davidbrai))
- Changed the session to count as busy while a run starts, including during `before_agent_start` handlers: `ctx.isIdle()` is false, `pi.sendMessage()` queues into the starting run instead of starting a second run that failed with "Agent is already processing", `pi.sendUserMessage()` requires `deliverAs`, and an abort requested meanwhile aborts the run once it starts ([#10739](https://github.com/earendil-works/pi/pull/10739) by [@davidbrai](https://github.com/davidbrai))
- Changed `pi mcp list --json` to report `resources: true` for servers that offer resources instead of `resources` and `resourceTemplates` counts; Pi no longer lists resources when connecting ([#10526](https://github.com/earendil-works/pi/issues/10526))

### Added

- Added `reachesTools` to tool definitions, so tools that reach other tools (such as `codemode` and `tool_search`) declare which tools a call may reach; the MCP extension uses it to wait for the servers a call needs and to decide whether a replacement `codemode` or `tool_search` tool can reach MCP tools
- Added `aliases` to tool namespaces; codemode's `describeNamespace()` and the `namespace` option of `searchTools()` match them, and MCP namespaces use the server name
- Added per-key OpenRouter model lists: with an OpenRouter key, Pi lists only the chat models that key may use, with the key's context size, max output, and prices, including guardrails and regional endpoints set as the base URL in `models.json`. The list is saved and used offline ([#10353](https://github.com/earendil-works/pi/issues/10353), [#10672](https://github.com/earendil-works/pi/pull/10672) by [@davidbrai](https://github.com/davidbrai))
- Added `PI_CLIPBOARD_OSC52=1` to send copied text to the terminal with OSC 52 after the local clipboard write, so copies reach a remote client's clipboard when Pi cannot detect the remote session, such as multiplexer attaches from another machine or remote IDE daemons ([#10826](https://github.com/earendil-works/pi/issues/10826), [#10835](https://github.com/earendil-works/pi/issues/10835), [#10114](https://github.com/earendil-works/pi/issues/10114))
- Added elapsed time while a codemode script runs and its total time once finished to the codemode tool row, like bash rows ([#10708](https://github.com/earendil-works/pi/issues/10708))

### Changed

- Changed the `showHardwareCursor` setting to use only the terminal cursor instead of also drawing Pi's reverse-video cursor
- Changed codemode tool declarations to show input constraints such as integer, minimum/maximum, length, pattern, and default as `@` tags on property comments, so scripts see them without the tool repeating them in descriptions ([#10707](https://github.com/earendil-works/pi/issues/10707))
- Changed codemode declarations of MCP tools to spell out the result type (`content`, `structuredContent`, `isError`) instead of referring to `CallToolResult<T>`, which `describeTool()`, `searchTools()`, and `ALL_TOOLS` showed without defining it; the codemode description no longer includes the shared MCP types
- Changed `serializeConversation()` (compaction, branch summaries, bug reports) to omit thinking blocks; replayed thinking is often not in the live context, so including it could make a summarization request larger than the context it summarizes and fail

### Fixed

- Fixed codemode ignoring a `// @options:` line that is not the first line of the script, which ran the script without the requested `timeout_ms`; the call now fails with an error before the script runs ([#10631](https://github.com/earendil-works/pi/issues/10631))
- Fixed Mistral streams being aborted mid-generation (e.g. during long thinking) after the request timeout; the timeout now applies only to waiting for response headers ([#10609](https://github.com/earendil-works/pi/issues/10609))
- Fixed a symlinked `AGENTS.md` in a git worktree nested inside its main repo causing no project context file to load ([#10681](https://github.com/earendil-works/pi/issues/10681))
- Fixed the code mode tool description claiming every failed tool call rejects; a tool that declares an output schema resolves with its value on failure too (e.g. `bash` with a nonzero exit)
- Fixed runs started by `pi.sendMessage(..., { triggerTurn: true })` removing system prompt sections added in `before_agent_start` after their first tool call, which changed the prompt mid-run and broke the provider prompt cache twice per run ([#10267](https://github.com/earendil-works/pi/issues/10267), [#10739](https://github.com/earendil-works/pi/pull/10739) by [@davidbrai](https://github.com/davidbrai))
- Fixed codemode blocking the process for seconds to minutes after scripts with many `text()` calls; joining the output items was quadratic ([#10678](https://github.com/earendil-works/pi/issues/10678))
- Fixed print mode (`-p`) exiting 0 without a warning when the final response was cut off at the model's output token limit; it now prints the partial text, writes a warning to stderr, and exits 1 ([#10799](https://github.com/earendil-works/pi/issues/10799))
- Fixed `pi mcp login --help` and the CLI docs describing `--timeout` as only the wait for the browser; it limits the whole sign-in ([#10636](https://github.com/earendil-works/pi/issues/10636))
- Fixed `~` not being expanded in `!pattern`, `+path`, and `-path` entries of the `extensions`, `skills`, `prompts`, and `themes` settings, so entries like `!~/skills/pdf` matched nothing ([#10765](https://github.com/earendil-works/pi/issues/10765))
- Fixed MCP servers with resources registering no tools until every resource was listed; Pi no longer lists resources when connecting, so `/mcp` and `pi mcp list` show that a server offers resources instead of counting them ([#10526](https://github.com/earendil-works/pi/issues/10526))
- Fixed MCP tool calls failing when the server returns structured content that is not an object (an array, `null`, or a primitive, as MCP 2026-07-28 allows); codemode declarations of MCP tools without an output schema now type `structuredContent` as `unknown` instead of an object ([#10416](https://github.com/earendil-works/pi/issues/10416))
- Fixed reading or writing `auth.json` on Windows failing with `EPERM` when the previous lock folder was still being deleted; Pi now retries briefly before reporting the error ([#10801](https://github.com/earendil-works/pi/issues/10801))
- Fixed OpenRouter router models such as `openrouter/auto` showing a cost of -$1,000,000 per 1M tokens; OpenRouter's negative placeholder prices are now 0 ([#10672](https://github.com/earendil-works/pi/pull/10672) by [@davidbrai](https://github.com/davidbrai))
- Fixed Anthropic requests failing when the provider rejects the strict tool set for grammar size, tool count, or union limits; Pi now retries once with preferred tools non-strict ([#10409](https://github.com/earendil-works/pi/issues/10409))
- Fixed "The upstream provider returned an error" not being retried as a transient provider error ([#10842](https://github.com/earendil-works/pi/issues/10842))
- Fixed focused fullscreen overlays blocking mouse-wheel scrolling of the transcript ([#10769](https://github.com/earendil-works/pi/issues/10769))
- Fixed fragmented terminal color replies leaking hex values into the prompt and opening the external editor (related reports: [#10256](https://github.com/earendil-works/pi/issues/10256), [#10657](https://github.com/earendil-works/pi/issues/10657))
- Fixed inline images not rendering in Herdr since 1.1.0 ([#10774](https://github.com/earendil-works/pi/pull/10774) by [@ogulcancelik](https://github.com/ogulcancelik))
- Fixed key bindings that name a shifted symbol, such as `+` or `ctrl++`, not matching under the Kitty keyboard protocol or modifyOtherKeys ([#9880](https://github.com/earendil-works/pi/pull/9880) by [@christianklotz](https://github.com/christianklotz))
- Fixed the compaction status indicator embedded in a custom editor using the default muted colors instead of the editor border or thinking-level color, as the working indicator does ([#10809](https://github.com/earendil-works/pi/issues/10809), [#10810](https://github.com/earendil-works/pi/pull/10810) by [@Jay-Madden](https://github.com/Jay-Madden))
- Fixed MCP tool calls that were cancelled or timed out while waiting for an OAuth refresh still being sent to the server once the refresh finished ([#10598](https://github.com/earendil-works/pi/issues/10598))
- Fixed MCP OAuth sign-in accepting an authorization response with an `iss` parameter that could not be checked because no authorization server metadata was discovered; sign-in now fails with an issuer mismatch. Reported by [@AizenvoltPrime](https://github.com/AizenvoltPrime)
- Fixed codemode failing with a broken bridge error when Pi runs under `node --watch` on Node 24 or 26 ([#10725](https://github.com/earendil-works/pi/issues/10725))

### Removed

- Removed the unreleased experimental server, client, and plugin stack (`src/experimental`, `src/cli/experimental`) and its source-only `./client` and `./experimental/plugin` exports; none of it was part of the published package. The `@earendil-works/pi-client`, `@earendil-works/pi-protocol`, and `@earendil-works/pi-server` packages it used are removed and no longer released
- Removed the dependency on `@earendil-works/chord`

## 1.1.0

### New Features

- **Program status reporting**: terminals and agent dashboards that support OSC 7501 see whether Pi is working, blocked on a dialog or login, done, or failed. See [Program status](docs/terminal-setup.md#program-status).
- **Claude Haiku 5.5**: `anthropic/claude-haiku-5-5`, with adaptive thinking up to `xhigh`/`max` effort.
- **Adjust default tools with `+name`/`-name`**: `--tools` entries like `pi -t +codemode,-write` change the default selection instead of replacing it. See [Tools](docs/cli.md#tools).
- **GPT-6 Luna and image classification**: OpenAI's GPT-6 Luna is available as a classifier model through the Decisions API, and codemode's `models.classify()` accepts images for classifiers that support them. See [Use classifier models](docs/models.md#use-classifier-models).
- **Native llama.cpp decision models**: Julia-1, Laya, Kev, lev, and OpenJev served by llama.cpp 0.6.0 or later run natively as classifiers through `/v1/systemone`. See [Classification](docs/llama-cpp.md#classification).

### Added

- Added `+name` and `-name` entries to `--tools`, which change the default tool selection instead of replacing it, for example `pi -t +codemode`
- Added `durationMs` to the tool render context and to `tool_execution_end` extension events: the recorded execution time of a final tool result ([#10549](https://github.com/earendil-works/pi/issues/10549))
- Added `outputPad` to the tool render context ([#10557](https://github.com/earendil-works/pi/pull/10557) by [@rwachtler](https://github.com/rwachtler))
- Added OpenAI's GPT-6 Luna as a classifier model through the Decisions API, available with `OPENAI_API_KEY` (see [Use classifier models](docs/models.md#use-classifier-models))
- Added `images` to codemode's `models.classify()` context, so classifiers that accept images, such as GPT-6 Luna, can judge them
- Added program status reporting with OSC 7501: terminals and agent dashboards that support it see whether Pi is working, blocked on a dialog or login, done, or failed. `PI_PROGRAM_STATUS=1|0` overrides detection (see [Terminal setup](docs/terminal-setup.md#program-status)) ([#10607](https://github.com/earendil-works/pi/issues/10607))
- Added `aborted` to `agent_settled` session, extension, and JSON events, so integrations can tell a cancelled run from a finished one ([#10607](https://github.com/earendil-works/pi/issues/10607))
- Added Claude Haiku 5.5 (`anthropic/claude-haiku-5-5`), with adaptive thinking up to `xhigh`/`max` effort and prompt caching on Bedrock
- Added native llama.cpp decision models: Julia-1, Laya, Kev, lev, and OpenJev served by llama.cpp 0.6.0 or later are listed only as classifiers through `/v1/systemone` instead of as chat models (see [Classification](docs/llama-cpp.md#classification)) ([#10382](https://github.com/earendil-works/pi/pull/10382))

### Changed

- Changed `outputPad` to also apply to `!` command output, tool output, and summary blocks ([#9946](https://github.com/earendil-works/pi/issues/9946), [#10557](https://github.com/earendil-works/pi/pull/10557) by [@rwachtler](https://github.com/rwachtler))
- Changed `pi mcp login --timeout` to limit the whole sign-in, including requests to the authorization server, instead of only the wait for the browser ([#10565](https://github.com/earendil-works/pi/issues/10565))

### Fixed

- Fixed bash and PowerShell results losing `Took` after reloading a session, and the live `Took` including wall-clock steps; both now show the recorded execution time ([#10549](https://github.com/earendil-works/pi/issues/10549))
- Fixed managed installs keeping every old release; `pi update` now keeps only the new release and the one it updated from ([#10392](https://github.com/earendil-works/pi/issues/10392), [#10511](https://github.com/earendil-works/pi/pull/10511) by [@davidbrai](https://github.com/davidbrai))
- Fixed standalone binaries loading `.env`, `.env.local`, and `.env.development` from the launch directory into Pi's environment ([#10473](https://github.com/earendil-works/pi/issues/10473))
- Fixed `!!` command headers losing their dim color once output arrives ([#10557](https://github.com/earendil-works/pi/pull/10557) by [@rwachtler](https://github.com/rwachtler))
- Fixed the codemode description not marking `searchTools()`, `describeTool()`, and `describeNamespace()` as async, which led models to serialize the unawaited promise as `{}` ([#10555](https://github.com/earendil-works/pi/issues/10555))
- Fixed codemode output items running together, so models could not tell where one `text()` or `console.log()` output ended and the next began. With several text items, each now starts with a `==> text N/M <==` line, and `console` calls follow the other output in one `<console_output>` block with one line per call
- Fixed `/mcp` waiting for all servers to connect before opening; the manager now updates live and remains usable while enabling, reconnecting, or disabling servers ([#10562](https://github.com/earendil-works/pi/issues/10562))
- Fixed images being dropped as "could not be resized" when running under `node --watch` on Node 24.19+ and 26.x, where Node posts its own messages on the image resize worker channel ([#10527](https://github.com/earendil-works/pi/issues/10527))
- Fixed clipboard paste doing nothing in Termux, and failed copies there omitting the Termux:API install hint ([#10391](https://github.com/earendil-works/pi/issues/10391))
- Fixed `!` and RPC `bash` output keeping fragments of color codes, such as a stray `m`, when a code was split across output chunks ([#10504](https://github.com/earendil-works/pi/issues/10504))
- Fixed MCP OAuth sign-ins that could not be cancelled while waiting on the authorization server and kept running after the session ended. The sign-in screen now cancels with Esc at every step, session shutdown aborts a running sign-in, and each request to the authorization server times out after 15 seconds ([#10565](https://github.com/earendil-works/pi/issues/10565))
- Fixed shutdown waiting up to 15 seconds to refresh an MCP OAuth token that was about to expire, only to close the server's session ([#10565](https://github.com/earendil-works/pi/issues/10565))
- Fixed the fullscreen text selection surviving session switches and other transcript rebuilds, which highlighted unrelated text in the new transcript ([#9311](https://github.com/earendil-works/pi/issues/9311), [#10567](https://github.com/earendil-works/pi/pull/10567) by [@christianklotz](https://github.com/christianklotz))
- Fixed OpenAI models on Bedrock ignoring the thinking level and always running at Bedrock's default reasoning effort ([#9331](https://github.com/earendil-works/pi/issues/9331), [#10142](https://github.com/earendil-works/pi/pull/10142) by [@jsanter27](https://github.com/jsanter27))
- Fixed model `headers` in `models.json` not overriding the `originator` and `User-Agent` headers of Codex requests ([#10429](https://github.com/earendil-works/pi/pull/10429) by [@lucasmeijer](https://github.com/lucasmeijer))
- Fixed `server_busy` and `servers are currently busy` provider errors ending the turn instead of being retried ([#10543](https://github.com/earendil-works/pi/issues/10543))
- Fixed Mistral responses that end with `finish_reason: "error"` not being retried ([#10487](https://github.com/earendil-works/pi/issues/10487))
- Reduced context-limit request failures by estimating input at 3.5 characters per token instead of 4 when calculating output limits ([#10497](https://github.com/earendil-works/pi/issues/10497))
- Fixed Radius models disabled by an organization owner still being listed
- Fixed Anthropic browser login failing with "localhost refused to connect" when port 53692 is reserved or in use, for example by Hyper-V/WSL port exclusions on Windows: login now falls back to a free loopback port ([#10571](https://github.com/earendil-works/pi/issues/10571))
- Fixed session costs undercounting long prompts on models with prompt-length pricing tiers, such as Claude Haiku 5.5, Gemini 3.1 Pro, and GPT-5.4, through OpenCode, OpenCode Go, OpenRouter, Vercel AI Gateway, Google, MiniMax, and other providers
- Fixed Markdown links not being clickable in Herdr ([#10573](https://github.com/earendil-works/pi/issues/10573))

## 1.0.4

### New Features

- **Tool patterns and `--no-mcp`**: `--tools` and `--exclude-tools` accept `*` patterns, for example `--tools read,codemode,'mcp__radius__*'` keeps only one MCP server's tools. `--tools` now keeps MCP tools unless an entry starts with `mcp__`, and `--no-mcp` turns off MCP for one run. See [Tools](docs/cli.md#tools) and [MCP tools](docs/cli.md#mcp-tools).
- **Codemode persists images**: `tools.read()` on an image file now gives back an image block that `image()` can show. See [Call tools](docs/codemode.md#call-tools).

### Added

- Added `*` patterns to `--tools` and `--exclude-tools`, for example `--tools read,codemode,'mcp__radius__*'`
- Added `--no-mcp` to disable the built-in MCP support for one run

### Fixed

- Fixed syntax highlighting losing colors after the first line of multiline strings and comments in fenced code blocks ([#10143](https://github.com/earendil-works/pi/issues/10143))
- Fixed codemode scripts not receiving images from `read`: `tools.read()` now resolves to an image block for image files, which `image()` shows ([#10251](https://github.com/earendil-works/pi/issues/10251))
- Fixed MCP OAuth sign-in failing with `invalid_redirect_uri` on servers with OpenID Connect client registration, such as `mcp.modem.dev`: pi now registers as a native client ([#10493](https://github.com/earendil-works/pi/issues/10493))
- Fixed `--tools` removing MCP tools, which left `pi --tools codemode` without any MCP servers. `--tools` now keeps MCP tools unless an entry starts with `mcp__`
- Fixed MCP session shutdown returning while a server was still connecting, leaving its transport open until the server answered or timed out ([#10249](https://github.com/earendil-works/pi/issues/10249))
- Fixed system prompt rules and the skills hint naming tools hidden by `prepareLoadout`. Hidden tools are left out of the rules, the skills hint names no tool when the file reader is hidden, and `codemode` shows each tool's prompt guidelines with its declaration; `ToolLoadout` gains `getPromptGuidelines()` ([#10343](https://github.com/earendil-works/pi/issues/10343))
- Fixed Bedrock requests that fail with `The pending stream has been canceled` after a stalled HTTP/2 connection not being retried automatically ([#10379](https://github.com/earendil-works/pi/issues/10379))
- Fixed codemode scripts that patch built-ins (for example `Array.prototype.toJSON = ...`) crashing pi and leaving the tool call unsettled. Built-ins are now frozen before the script runs, so such patches have no effect ([#10444](https://github.com/earendil-works/pi/issues/10444))

## 1.0.3

### New Features

- **Azure Foundry Chat Completions** — The `azure` provider (renamed from `azure-openai-responses`) now also serves Foundry Chat Completions deployments, starting with `azure/deepseek-v4-pro`. See [Azure OpenAI](docs/providers.md#azure-openai).
- **Codemode images saved to files** — `image()` also writes each image to a temp file and names the path in the result, so later turns can copy or move generated images. See [Generate images](docs/codemode.md#generate-images).

### Breaking Changes

- Renamed the Azure provider from `azure-openai-responses` to `azure`. Rename the provider key in `auth.json` (or run `/login` again), in `models.json`, and in `settings.json` (`defaultProvider`, `enabledModels` patterns, and `modelThinkingLevels` keys). Sessions that used the old provider fall back to another model when resumed, and their prompt cache is not reused. The `AZURE_OPENAI_*` environment variables are unchanged ([#9714](https://github.com/earendil-works/pi/pull/9714) by [@jsanter27](https://github.com/jsanter27))

### Added

- Added Azure Foundry Chat Completions deployments, starting with `azure/deepseek-v4-pro` ([#9645](https://github.com/earendil-works/pi/issues/9645), [#9714](https://github.com/earendil-works/pi/pull/9714) by [@jsanter27](https://github.com/jsanter27))

### Changed

- Codemode `image()` now also saves each image to a temp file and names the path in the result, so later turns can copy or move generated images ([#10310](https://github.com/earendil-works/pi/issues/10310))
- Output files (full text of truncated tool output, binary MCP resources, codemode images) are now readable only by the user
- `Home`/`End` now always move the editor cursor to the line start/end; fullscreen transcript top/bottom moved to `Ctrl+Home`/`Ctrl+End`, which no longer move the editor cursor ([#10314](https://github.com/earendil-works/pi/issues/10314))

### Fixed

- Fixed subscription logins such as Sign in with ChatGPT failing with `refresh_token_invalidated` after a request was cancelled during an OAuth token refresh
- Fixed codemode failing for the rest of a session after a pnpm global update removed the running install, and added a restart hint when errors occur after pi was updated or removed on disk ([#10439](https://github.com/earendil-works/pi/issues/10439))
- Fixed interactive sessions reporting a `read EIO` or `setRawMode EIO` crash (and asking to run /bug) when the terminal went away, e.g. after closing the window or resuming a suspended pi in a closed terminal

## 1.0.2

### New Features

- **Sampling by thinking level** — `samplingParamsByThinkingLevel` in `models.json` sets sampling parameters such as `temperature` and `top_p` for each thinking level on OpenAI-compatible APIs. See [Configure sampling by thinking level](docs/models.md#configure-sampling-by-thinking-level).

### Added

- Added `samplingParamsByThinkingLevel` to `models.json` for per-thinking-level sampling parameter overrides on OpenAI-compatible APIs. See [Configure sampling by thinking level](docs/models.md#configure-sampling-by-thinking-level) ([#9776](https://github.com/earendil-works/pi/pull/9776) by [@mrexodia](https://github.com/mrexodia))

## 1.0.1

### New Features

- **Nix flake** — `nix run github:earendil-works/pi/stable` runs the latest release, and `nix profile add github:earendil-works/pi/stable` installs it. See [Install pi](docs/quickstart.md#1-install-pi).
- **Project overrides for MCP servers** — `.pi/mcp.json` and `/mcp` can enable, disable, or change the exposure of a user-level server for one project. See [Configure servers](docs/mcp.md#configure-servers).
- **MCP Client ID Metadata Documents** — `oauth.clientRegistration: "cimd"` lets authorization servers allow pi by its document URL instead of dynamic registration. See [Authenticate with OAuth](docs/mcp.md#authenticate-with-oauth).
- **Tool renderers for any tool** — `pi.registerToolRenderer()` draws calls to tools that are not registered yet, such as MCP tools in resumed sessions. See [Tool rendering](docs/extensions.md#tool-rendering).
- **Cloudflare Clef classifiers** — `@cf/cloudflare/clef` and `@cf/cloudflare/clef-flash` are usable from codemode scripts and extensions. See [Use classifier models](docs/models.md#use-classifier-models).

### Added

- Added a copy key (`app.message.copy`, default `ctrl+x`) to OAuth sign-in screens in `/login`, `/mcp`, and `/mcp login`, which copies the sign-in URL when the browser cannot be opened or the wrapped link cannot be selected.
- Added `oauth.clientRegistration: "cimd"` for MCP servers, which identifies pi with its Client ID Metadata Document on pi.dev instead of dynamic client registration, so authorization servers can allow pi by URL ([#10302](https://github.com/earendil-works/pi/issues/10302))
- Added project overrides for user-level MCP servers: a `.pi/mcp.json` entry without `command` or `url` sets only `enabled`, `exposure`, and `toolExposure` of the user-level server, and `/mcp` can enable or disable a server for the current project ([#10277](https://github.com/earendil-works/pi/issues/10277))
- Added Cloudflare's Clef and Clef Flash classifier models to `cloudflare-workers-ai`, usable from codemode scripts and extensions ([#10316](https://github.com/earendil-works/pi/pull/10316) by [@ndisidore](https://github.com/ndisidore), [#10322](https://github.com/earendil-works/pi/pull/10322) by [@RealAlexandreAI](https://github.com/RealAlexandreAI))
- Added `pi.registerToolRenderer()`, which chooses how calls to a tool are drawn, including tools that are not registered ([#10285](https://github.com/earendil-works/pi/issues/10285))
- Added a Nix flake for macOS and Linux: `nix run github:earendil-works/pi/stable` runs the latest release, and `nix profile add github:earendil-works/pi/stable` installs it. See [Install pi](docs/quickstart.md#1-install-pi) ([#9137](https://github.com/earendil-works/pi/pull/9137))

### Changed

- `pi update` on global npm installations now recommends migrating to the managed installation from the pi.dev installer, which pins all dependencies.
- Anthropic tools added or redefined mid-conversation are now defined inline in the conversation, so redefining a tool under the same name keeps the prompt cache instead of resending the full tool list.

### Fixed

- Fixed installations resolving vulnerable `brace-expansion` 5.0.9 by pinning `brace-expansion` 5.0.12 as a direct dependency (GHSA-q2hr-2g5m-vwhr, GHSA-qhr7-859c-m2p7, GHSA-6j4f-fj2g-mc7p) ([#10288](https://github.com/earendil-works/pi/issues/10288))
- Fixed a trailing comma in `--models` adding an extra model to the model cycle ([#10334](https://github.com/earendil-works/pi/issues/10334))
- Fixed a `codemode` script that prints in a loop crashing pi by running out of memory: a script fails once its output passes 16 Mi characters or 100000 items ([#10283](https://github.com/earendil-works/pi/issues/10283))
- Fixed JPEG, GIF, and WebP images rendered by extensions through `Image` not appearing in Kitty, Ghostty, WezTerm, and Warp ([#10292](https://github.com/earendil-works/pi/issues/10292))
- Fixed MCP tool calls in resumed sessions and HTML exports rendering fully expanded until their server connected, or for good if it never did ([#10285](https://github.com/earendil-works/pi/issues/10285))
- Fixed fullscreen Kitty images collapsing to a one-row strip after scrolling in WezTerm ([#10319](https://github.com/earendil-works/pi/issues/10319))
- Fixed "Selected model is at capacity" provider errors ending the turn instead of being retried ([#10278](https://github.com/earendil-works/pi/issues/10278))
- Fixed Cloudflare AI Gateway Claude models failing with a 404 by using dashed model IDs (`claude-opus-5-5` instead of `claude-opus-5.5`)
- Fixed Sign in with ChatGPT continuing when its callback port is taken by another login, which made the browser show "OAuth state mismatch"; it now fails with a port-in-use error ([#10265](https://github.com/earendil-works/pi/issues/10265))
- Fixed Amazon Bedrock OpenAI models costing requests above 272k input tokens at the short-context rate; Bedrock models now include the pricing tiers listed on models.dev ([#10326](https://github.com/earendil-works/pi/issues/10326))
- Fixed Amazon Bedrock Claude requests failing with "Invalid `signature` in `thinking` block" after the system prompt or tools changed ([#10324](https://github.com/earendil-works/pi/issues/10324))
- Fixed Together DeepSeek V4 Pro losing its thinking level controls after Together renamed it to `deepseek-ai/DeepSeek-V4-Pro-0813` ([#10336](https://github.com/earendil-works/pi/pull/10336) by [@cv](https://github.com/cv))
- Fixed the default NVIDIA model pointing at `nvidia/nemotron-3-super-120b-a12b`, which NVIDIA no longer serves; the default is now `nvidia/nemotron-3-ultra-550b-a55b`

### Removed

- Removed `npm-shrinkwrap.json` from the published package. npm installations no longer pin transitive dependencies, and library consumers can now override them. Use the pi.dev installer for pinned installations ([#5653](https://github.com/earendil-works/pi/issues/5653))
