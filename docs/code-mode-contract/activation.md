# Native contracts and activation (#300)

The default `packages/ext/codex-adapter/index.ts` exports the Code Mode registration in `code-mode/registration.ts`. The temporary gate and legacy direct adapter registration/guidance have been removed by #302. Unsupported models use normal Pi core tools.

## Reproduce the definitions

Use the selected Codex Git revision, not checkout HEAD:

```sh
python3 scripts/extract-code-mode-contract.py ~/projects/codex /tmp/code-mode-evidence
python3 scripts/generate-code-mode-contract.py /tmp/code-mode-evidence packages/ext/codex-adapter/code-mode/contract.generated.json
bunx oxfmt --write packages/ext/codex-adapter/code-mode/contract.generated.json
```

The evidence directory must be new. The generator verifies source SHA-256 against
`source-manifest.json` and native text against `native-text.json`. Primitive shell,
wait and image property wording, output schemas, and web operation documentation
are extracted from those verified Rust sources. Only the selected supported fields
are projected. The small locked Rust build in `scripts/code-mode-contract` calls
**the retained upstream `build_exec_tool_description`**, with `code_mode_only=true`
and no deferred tools, for each supported definition. Runtime composition selects
those generated sections according to actual nested availability; `ALL_TOOLS` and
host dispatch receive the same descriptions/schemas. Rust/Cargo caches are needed
for offline generation; no generator or compiler runs during Pi startup.

Reviewed deviations from the pin remain those in the baseline: omit sandbox and
environment fields; use Pi's configured shell; project web to five operations and
its retained request-size limits, preserving the full applicable web guidance;
rename the native `web__run` interface to `web_run`; expose only original image
resolution; omit audio/generation helper advertising; remove the unavailable MCP
tool-name example and omit the shell example when shell delegation is unavailable; describe `notify()` as queued model output. The native await,
isolate finalization, and rejection wording is unchanged. No model prompt or
promise-batching advice is imported.

`output.ts` ports the pin's UTF-8 middle truncation and text/image budget behavior
from `utils/string/src/truncate.rs` and `utils/output-truncation/src/lib.rs` (both
are now included in the source evidence manifest). Status and wall time retain the
native shape. Failed scripts keep accumulated output/images; an exec/wait-specific
Pi `tool_result` hook sets error status before persistence. Bounded nested traces
remain in `details` for nested rendering, never appended to the model result.

## Scope and selection

IDs are normalized for case and surrounding whitespace. Accepted base families
are `gpt-5.6` and `gpt-6`, optionally followed by nonempty hyphenated alphanumeric
variant segments. One recognized provider prefix may precede the ID:
`openai/`, `openai-codex/`, `azure/`, `azure-openai/`, `github-copilot/`, `openrouter/`.
Thus `gpt-6-astra` and `openai/gpt-5.6-pro` match; `gpt-60`, `gpt-6.1`, `gpt-7`,
`unknown/gpt-6`, and opaque aliases do not. The provider and API names never grant
model eligibility. The obsolete `codexAdapter.providers` option has been removed. Unknown keys in existing configuration remain ignored, with no provider-wide activation.

Model-visible tools and nested callable tools are separate sets. Initial session
selection bounds both: explicitly unavailable adapter tools are not recovered
from `getAllTools()` or reconstructed through core-tool aliases. Shell delegation
also requires selected `bash`; patch delegation requires selected `edit` or
`write`. Core tools are displaced only when their selected replacement is callable;
for example a read-only session retains direct `read`, not an unrestricted shell.
Web/image delegates also obey their existing route/input availability at every
invocation. Hidden auxiliary selection survives model switches. Removing a visible
exec/wait tool does not re-enable it on the next reconciliation or scope round trip.
Displaced core tools return immediately when their replacement becomes unavailable,
including while the selected model remains supported. Explicitly re-adding exec/wait
clears the corresponding disable and restores visibility; a model switch alone
does not. Core capabilities removed while replacements are disabled remain removed
after re-enabling; nested membership is recomputed from the current core selection.
Unrelated tools keep their order. Disabling the adapter restores only displaced
core tools and never leaves standalone `web_run`.

Disabling bash-gate independently means nested commands use the existing executor
without command authorization, just as normal Pi commands do with that extension
disabled. Enabling Code Mode never registers or implicitly enables a second gate.

## Pi ownership and lifetime

Installed documentation is Pi 0.85.1; local runtime dependencies are 0.85.0.
The decisive references are `docs/extensions.md` (Tool Definition, runtime tool
registration, session replacement lifecycle), `docs/models.md` (OpenAI
Compatibility), `docs/skills.md`, and `docs/sessions.md`. The registration uses Pi's
stock `constrainedSampling` with one required string field, `code`. Stock OpenAI
Responses, Codex Responses, Azure Responses and Completions serializers select raw
Lark input only with `compat.supportsOpenAIGrammarTools === true`. Otherwise the
wire call is an ordinary function with `{code:string}`. The description's input
sentence follows that difference. No provider/auth/transport registration changes.

Dynamic description replacement uses `registerTool`, followed by `setActiveTools`
using the pre-refresh snapshot: Pi can reactivate allowlisted tools while refreshing
its registry. Chained `before_agent_start.systemPrompt` remains authoritative.
The skill catalog uses Pi's formatter and changes only the file-loading sentence:
load through `tools.exec_command` inside `exec` and **emit** the contents with
`text(result.output)`. Pi has no separate loaded-skill registry. Existing read-based
catalogs, project/Pi-bites/later-extension contributions, and `/context` previews
keep the same composition seam; nested tool definitions are counted under exec.

Lifecycle events capture stable dependencies synchronously. Supported model
switches refresh availability without replacing the runtime. Successful tree
navigation, leaving scope, replacement, reload and shutdown invalidate cells,
stored values and owned shells. Bridge snapshots/navigation/traces clear even if
no runtime was started. Notifications use the extracted UI method, never captured
ctx getters. Replacement/reload creates fresh extension instances and managers;
model/tree events do not terminally shut down the shared shell manager.

## Verification

Behavioral tests cover scoped IDs, tool selection/restoration, registered lifecycle,
real-host exec/wait/state/branch cleanup and throwing stale getters, failed output
with images, and stock provider payloads. Payload tests stop before network access. The [cutover record](cutover.md) separately records live route smoke and its limitations. Host tests run against an explicitly supplied
`PI_BITES_TEST_CODE_MODE_HOST`, the manual installation, or the retained local build;
without any host, native integration tests skip. Final repository validation is
`bun check`, including Node and Bun host/registration checks.

Validation on 2026-09-11: `bun check` passed (1,329 main tests, 70 Bun tests; four
existing skips). The registered exec/wait exercise used the local Linux x64 pinned
host build; stock Responses/Codex Responses/Completions payloads were captured for
both capability settings without sending requests. Contract regeneration compared
byte-for-byte after formatting, and the generator's locked offline Cargo build/test
and formatting check passed. No live model route or arm64 execution is claimed.
