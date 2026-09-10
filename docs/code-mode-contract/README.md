# Codex Code Mode contract baseline

Accepted 2026-09-09 for [#295](https://github.com/jamestrew/pi-bites/issues/295), under [epic #294](https://github.com/jamestrew/pi-bites/issues/294). This is the target contract for #296–#302, not a claim that Code Mode is active today. The current structured adapter remains unchanged until the coherent cutover. RTK removal (#292) is already in ancestor commit `6dc4c867`.

## Source selection and reproduction

Select **OpenAI Codex `rust-v0.145.0`, `25af12f7e61572b0bc18ddb1008be543b91519b0`** for the runtime, definitions, and semantics together. The bridge reference is **`@howaboua/pi-codex-conversion` 3.0.31**, repository `IgorWarzocha/howaboua-pi-stuff`, commit **`94eb6c0745e2f516bf19603f912f7b6478b43355`**. Its `packages/pi-codex-conversion/code-mode/UPSTREAM_SYNC.md` selects that host pin. Both commits were inspected locally. The newer Codex checkout `a62e98d18c6550e3bea152ed1b89d1e931dca961` is not the contract source. Existing shell/patch/web/image implementations retain their separately recorded provenance in [UPSTREAM.md](../../packages/ext/codex-adapter/UPSTREAM.md); this baseline does not relabel those implementations as newly vendored native code.

[Source manifest](source-manifest.json) records SHA-256 for every extracted file. [Native text](native-text.json) contains the exact native exec template, complete wait description, both grammars, and complete web description. It is **audit evidence only**: it includes unavailable audio and web operations and must never be registered as the Pi prompt unchanged. OpenAI's Apache-2.0 [license](../../packages/ext/codex-adapter/vendor/apply-patch/LICENSE-APACHE-2.0) and [notice](../../packages/ext/codex-adapter/vendor/apply-patch/NOTICE) apply to extracted text; the extractor also includes the pinned originals.

Reproduce from the repository root, using a fresh output directory:

```sh
python3 scripts/extract-code-mode-contract.py ~/projects/codex /tmp/code-mode-contract-audit
cmp docs/code-mode-contract/source-manifest.json /tmp/code-mode-contract-audit/manifest.json
cmp docs/code-mode-contract/native-text.json /tmp/code-mode-contract-audit/native-text.json
```

The extractor reads Git objects at the literal pin, never the checkout's HEAD or dirty files, and refuses an existing destination. It requires Python 3 and Git, no network or Rust build. The bundle's `source/` preserves entire definition and decisive implementation files, including optional fields and property descriptions; it does not attempt to parse Rust schemas with regex. Only raw string constants are extracted into JSON. To compare any source directly, use `git -C ~/projects/codex show 25af12f7e61572b0bc18ddb1008be543b91519b0:<path>`.

All source paths below are relative to `codex-rs/` at that pin. They link through the [pinned repository tree](https://github.com/openai/codex/tree/25af12f7e61572b0bc18ddb1008be543b91519b0/codex-rs), not a moving branch.

| Contract                                      | Definition / decisive behavior in the evidence bundle                                                                                 |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Exec text, declarations, parser               | `code-mode-protocol/src/description.rs`: `build_exec_tool_description`, `parse_exec_source`, `render_code_mode_sample_for_definition` |
| Exec grammar, wait JSON schema                | `core/src/tools/code_mode/{execute_spec,wait_spec}.rs`                                                                                |
| Runtime outcomes, defaults, content           | `code-mode-protocol/src/{runtime,response}.rs`; `code-mode/src/service.rs`                                                            |
| Model-visible response formatting             | `core/src/tools/code_mode/{mod,wait_handler,execute_handler}.rs`                                                                      |
| Shell descriptions, both input/output schemas | `core/src/tools/handlers/shell_spec.rs`                                                                                               |
| Shell waits and typed results                 | `core/src/tools/handlers/unified_exec.rs`; `core/src/unified_exec/{mod,process_manager}.rs`; `core/src/tools/context.rs`              |
| Patch description, grammar, success result    | `core/src/tools/handlers/{apply_patch_spec.rs,apply_patch.lark}`; `ApplyPatchToolOutput` in `core/src/tools/context.rs`               |
| Image input/output schemas and conversion     | `core/src/tools/handlers/{view_image_spec,view_image}.rs`                                                                             |
| Web description, schema, output               | `ext/web-search/web_run_description.md`, `ext/web-search/src/{tool,schema,output}.rs`, `codex-api/src/search.rs`                      |
| Names and default result conversion           | `tools/src/{code_mode,tool_output}.rs`                                                                                                |
| Cleanup / cancellation                        | `code-mode/src/cell_actor/{mod,callbacks}.rs`; `code-mode-host/src/peer.rs`                                                           |
| IPC shapes and bounds                         | `code-mode-protocol/src/host/{message,payload,codec}.rs`                                                                              |

### Generation for activation (#296 / #300)

The standalone host protocol has no description-export operation. Do not ask it for tool help or import conversion's `custom-tool-prompt.ts` summaries. The selected method is **pinned source extraction followed by build-time Rust generation**, outside the vendored source tree:

1. #296 retains the pinned library, source, lockfile, licenses, and Linux x64/arm64 host build provenance. Add a small generator in the local packaging layer that links the same `codex-code-mode-protocol` library. Do not copy later revisions' factories or full model templates.
2. Extract the factory schemas and exact description/property strings from the source bundle. For shell use Linux, `allow_login_shell=true`, `exec_permission_approvals_enabled=false`, `include_environment_id=false`, `include_shell_parameter=true`, then remove the three approval fields below. For image use both options false, then project its result as below. For patch use `include_environment_id=false`. For web generate `SearchCommands` with the exact `SchemaSettings` in `ext/web-search/src/schema.rs` (draft 2019-09, inline subschemas, `option_add_null_type=false`, same retained root keys), then select the retained operations. Preserve required arrays, enums, numeric types, and property descriptions. Do not substitute the current adapter's TypeBox descriptions.
3. Emit canonical JSON `ToolDefinition`s in sorted name order. The five plain names are `apply_patch`, `exec_command`, `view_image`, `web_run`, `write_stdin`; omit image/web when unavailable. Freeform patch has `kind=freeform`, null input/output schemas; functions carry input schemas. No deferred tools or namespace descriptions are needed. Keep native output schemas where supported; web/patch have no native output schema and therefore generate `Promise<unknown>` despite the concrete behavior below.
4. Call `build_exec_tool_description(enabled, [], empty_namespace_map, 10000, true)` on unaugmented definitions. The `true` includes nested declarations; it does not remove unrelated direct Pi tools. Let the pinned renderer produce optional-field syntax and comments. Use `augment_tool_definition` separately if needed for runtime metadata; do not double-append declarations. Preserve the extracted wait description/schema and exec grammar.
5. Apply only the explicit capability edits below to generated text. Every edit must match the expected source fragment exactly and fail generation if missing or ambiguous. Save the projected schemas, descriptions, generator inputs, and an edit manifest together. Check generated files into the activation change; regenerate and diff them in its validation. The extractor delivered here establishes reproducible source inputs; the linked Rust generator ships with native packaging, not this documentation change.

The web description's decision boundary, citation instructions, special cases, and word limits are tool text and remain intact. Remove unsupported operation examples and replace the mixed finance batching example with the same example minus its finance property. Remove screenshot-only references where they advertise screenshot capability. Do not import complete model prompts, conversion's abbreviated help, adaptive wait advice, or bespoke `Promise.allSettled` guidance.

## Outer tool contract

### `exec`

Exact description template and Lark grammar are in [native-text.json](native-text.json). Input is nonempty raw JavaScript, evaluated as an async module in a fresh V8 isolate. No Node, console, filesystem, or network APIs are exposed; capabilities come through `tools`. Nested calls accept objects or freeform strings and return JSON-compatible values. Neither a returned module value nor a nested result is automatically printed: script helpers produce model output.

The optional **first line** is `// @exec: {"yield_time_ms": 10000, "max_output_tokens": 1000}`, followed by a newline and nonempty JavaScript. Leading horizontal whitespace and CRLF are accepted. The native parser accepts only those two keys; invalid JSON, unknown keys, fractions, negatives, unsafe integers, an empty script, or a directive without source are errors. Missing or null pragma fields use defaults. Both numeric fields accept zero through `Number.MAX_SAFE_INTEGER`; there is no conversion-package 100,000-token cap or positive-only minimum in this contract.

| Field               | Default   | Native behavior                                                                                                                                                                     |
| ------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `yield_time_ms`     | 10,000 ms | Observation timeout, not script cancellation; no shell-style clamp. The runtime adds a 1-second grace period for requested waits at least 10 seconds (`service.rs::yield_timeout`). |
| `max_output_tokens` | 10,000    | Budget for the direct result, distinct from any nested shell budget. Zero is valid.                                                                                                 |

### `wait`

Exact description is in the native text artifact. Native JSON function schema: `strict=false`, `additionalProperties=false`, required `cell_id`; no output schema.

| Property        | Type              | Exact native property description                                    |
| --------------- | ----------------- | -------------------------------------------------------------------- |
| `cell_id`       | string, required  | Identifier of the running exec cell.                                 |
| `yield_time_ms` | number, optional  | Wait before yielding more output. Defaults to 10000 ms.              |
| `max_tokens`    | number, optional  | Output token budget for this wait call. Defaults to 10000 tokens.    |
| `terminate`     | boolean, optional | True stops the running exec cell; false or omitted waits for output. |

Native deserialization requires unsigned integers for numeric fields, although the schema says `number`; `yield_time_ms` and `terminate` reject explicit null, `max_tokens` accepts null as omitted. Defaults are 10,000 ms / 10,000 tokens / false. The Pi JSON bridge uses nonnegative safe integers to avoid JS precision loss, a transport restriction relative to Rust's wider integers. `terminate=true` selects termination instead of waiting. The outer result token budget belongs in Pi-side response formatting: host `WaitRequest` contains only `cell_id` and `yield_time_ms`, not `max_tokens` or `terminate`.

A wait returns only newly accumulated content. It can yield again with the same opaque string cell ID; consuming terminal completion closes the cell. An unknown/already consumed ID produces a failed result with `exec cell <id> not found`, not an empty successful completion. Shell session IDs are separate numbers.

### Results and errors

The host's serialized `RuntimeResponse` is an externally tagged union:

```ts
type Item =
  | { type: "input_text"; text: string }
  | {
      type: "input_image";
      image_url: string;
      detail?: "auto" | "low" | "high" | "original" | null;
    };
type RuntimeResponse =
  | { Yielded: { cell_id: string; content_items: Item[] } }
  | { Terminated: { cell_id: string; content_items: Item[] } }
  | { Result: { cell_id: string; content_items: Item[]; error_text: string | null } };
```

This is the supported text/image projection; native also has `input_audio`, rejected by this bridge. Host operations separately return `{status:"ok", value:...}` or `{status:"error", message:string}`. A wait's value wraps `outcome.LiveCell` or `outcome.MissingCell`. IPC envelopes are not model-visible results, and operation errors must not masquerade as successful script output.

Preserve the native outer text header:

```text
Script running with cell ID <id>
Wall time <seconds rounded to one decimal> seconds
Output:
```

Replace the first line with `Script completed`, `Script terminated`, or `Script failed` for terminal results. Failure appends `Script error:\n<error_text>` to content before truncation. Native termination is a successful control operation; native script error has success false. In Pi, return the accumulated text/images and rendering details with an internal failure marker in `details`; an `exec`/`wait`-scoped `tool_result` hook reads that marker and returns `{isError: true}`. Pi applies that hook before persisting the result, preserving content and image normalization. Do not throw a failed-cell result: Pi converts thrown errors to only `Error.message` text with empty details, discarding accumulated images. Ordinary dispatch exceptions still reject nested JS calls; the outer adapter preserves the resulting native failed-cell content through this hook. Keep images and failure display available to rendering even when text truncation applies.

Apply the per-call token budget to content, then prepend the status header, as native does. Retain native text/mixed-content truncation semantics when porting response formatting. Preserve the host's **64 MiB IPC frame limit**, existing bounded shell output, and bounded Pi rendering retention. A token budget is not a memory limit; #297 must bound accumulated bridge output and traces and report overflow visibly, without claiming an unimplemented model-selectable limit. Do not inherit the conversion bridge's 30-second exec default, wait backoff, or 1–100,000-token pragma restriction.

### Helpers

Exact signatures and original descriptions are in the native exec template. Retain `exit`, `text`, `image`, `store`, `load`, `notify`, `setTimeout`, `clearTimeout`, `ALL_TOOLS`, and `yield_control`, with these integration qualifications:

- `text` appends text; nonstrings use native JSON serialization where possible. `image` accepts a data URL, image-url object, or individual MCP image block; explicit detail overrides embedded detail. HTTP(S) image URLs are unsupported. Default native image detail is high. Pi transports may drop per-image detail metadata, so do not promise wire-level original-detail control.
- `store(key, value)` / `load(key)` retain serializable values across cells in the same runtime session; absent keys return undefined. They do not create persistent JavaScript variables or survive session/branch cleanup.
- `notify` is an actual host notification delegate. Pi sends an immediate UI partial update and retains its text for the next model-visible exec/wait result. Replace only the native claim about immediate `custom_tool_call_output` injection with this behavior; each notification appears once in returned content. Do not manufacture additional tool messages.
- `yield_control()` produces a real yielded result while execution continues. UI partial updates alone are not yields.
- Pending timers do not keep a completed module alive; awaited work does. Completion and `exit()` end the isolate and discard unawaited promises. `ALL_TOOLS` lists only enabled owned nested tools, not every Pi tool; no deferred-tool paragraph is needed.
- Remove `audio` from advertised help and reject native audio content. Remove `generatedImage` from advertised help because image generation is excluded. The unmodified host may still define these globals; their presence is not a supported capability or permission to add generation tools.

## Retained nested contracts

All five functions are on `tools`, and only the five owned adapters can be delegated. No generic execution API is implied. Each dispatch validates constructed arguments, availability, and cancellation before execution. Unknown/omitted-capability fields are rejected rather than silently ignored. Native optional JSON numeric fields that cross JS are subject to safe-integer validation; shell timing clamping still applies after validation. Rendering details never replace the typed JS return value.

### `tools.exec_command(args)` and `tools.write_stdin(args)`

Exact top-level descriptions:

- `exec_command`: “Runs a command in a PTY, returning output or a session ID for ongoing interaction.”
- `write_stdin`: “Writes characters to an existing unified exec session and returns recent output.”

The description says PTY generically; the `tty` property explicitly selects pipes by default. Both native schemas are non-strict objects with `additionalProperties=false`. Copy property descriptions and the output schema from `shell_spec.rs`, not current local summaries.

| Tool           | Required             | Optional supported fields                                                                                                  |
| -------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `exec_command` | `cmd: string`        | `workdir: string`, `shell: string`, `tty: boolean`, `login: boolean`, `yield_time_ms: number`, `max_output_tokens: number` |
| `write_stdin`  | `session_id: number` | `chars: string`, `yield_time_ms: number`, `max_output_tokens: number`                                                      |

`workdir` defaults to the current turn/session cwd; relative paths resolve there. `shell` defaults to Pi's configured shell (a necessary host integration edit to native “user's default shell”). `login` defaults true; `tty` defaults false. `chars` defaults empty, polling without writing. No aliases (`command`, `cwd`, `process_id`, `input`, `yield_time`) are advertised or accepted by the new dispatcher.

| Timing / output      | Selected behavior                                                                | Local drift to remove in #299                                                                 |
| -------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Initial shell wait   | default 10,000 ms; clamp 250–30,000 ms on Linux                                  | default 30,000, noninteractive minimum 5,000, maximum 1,800,000                               |
| Nonempty stdin write | default 250 ms; clamp 250–30,000 ms                                              | retain aligned values                                                                         |
| Empty poll           | raw default 250 ms clamps to **5,000 ms**; explicit wait clamps 5,000–300,000 ms | minimum/default 30,000; maximum 240,000                                                       |
| Wait mechanics       | deadline-based collection; process exit may return early                         | inactivity-reset timer must not stretch an explicit shell wait to the local larger hard limit |
| Output               | advertised default 10,000 tokens; explicit budget honored within output caps     | retain bounded tail output and dropped-byte accounting                                        |

The native nested shell conversion in `ExecCommandToolOutput::code_mode_result` returns raw collected output when `max_output_tokens` is omitted, truncating when explicitly set; the direct tool formatter applies the default budget. Pi retains its existing 10,000-token default nested cap as a bounded-output adaptation, plus the existing 1 MiB live buffer / 8 MiB native retained-output cap. Do not imply unlimited output or silently lose eviction accounting. The local 256-character minimum must not override an explicit zero/small budget; align that straightforward drift in #299.

Both JS results have exactly this supported shape (the native output schema requires only `wall_time_seconds` and `output`):

```ts
type ShellResult = {
  wall_time_seconds: number;
  output: string;
  chunk_id?: string;
  exit_code?: number;
  session_id?: number;
  original_token_count?: number;
};
```

Running commands return `session_id`; finished commands return `exit_code`. Preserve omitted optional properties rather than introducing nulls. Nonzero command exit is a resolved result with `exit_code`, not a rejected promise. Failures to authorize, start, validate, or access an existing session reject. The current `throwForExecFailure` behavior must not be used at the nested seam. The manager already supplies the typed result; do not parse formatted shell text or spread renderer `details` indiscriminately.

Omit `sandbox_permissions`, `justification`, and `prefix_rule` from the selected factory result. Do not enable `additional_permissions` or `environment_id`. Bash-gate authorizes commands but cannot enforce Codex filesystem/network permission profiles or reusable sandbox prefixes. Keep its shared classification, Auto Mode, allowances, audit records, and human escalation; no new model-facing sandbox fields are necessary. The native Windows timing and guidance branch is not selected for bundled Linux artifacts.

### `tools.apply_patch(input: string)`

Exact description: “The `apply_patch` tool can be used to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON.” Native `kind=freeform`, no input or output JSON schema; the generated return annotation is `Promise<unknown>`.

Pass the patch string itself to the owned parser/executor (internally adapting to its `{input}` shape). The exact grammar is in the native text artifact: `*** Begin Patch`, one or more add/delete/update hunks, `*** End Patch`; move/context/EOF syntax comes from `apply_patch.lark`. No `*** Environment ID:` extension is supported. The grammar informs the contract, but nested strings are validated by the patch parser; they are not separate provider grammar calls.

**Native successful Code Mode result is `{}`**, from `ApplyPatchToolOutput::code_mode_result`, even though the direct patch tool has readable success text. Return `{}` to JS; keep patch details/success text for the nested renderer. Invalid patch, denied access, and application failures reject. A partially applied patch is not rolled back or a successful value: retain applied-file details and existing partial-failure feedback before rejecting. #299 must call the shared partial-failure handling explicitly; an owned `.execute()` call does not emit Pi's ordinary `tool_result` hook.

### `tools.web_run(args)`

The selected native standalone web tool is namespace **`web`**, function **`run`**; native Code Mode maps it to **`tools.web__run`**. The epic deliberately retains the local name **`tools.web_run`** to bridge the existing five owned tools. This is an explicit integration alias, not an upstream spelling claim. Do not expose both names or native hosted `web_search` as another capability.

Start with the full native web description and retain only the five operations below plus `response_length`. Property descriptions come from `SearchCommands` and operation structs in `codex-api/src/search.rs`; `ext/web-search/src/schema.rs` preserves their metadata. Every outer property is optional; individual operation fields marked required below remain required. Native response length is optional (`short|medium|long`); its description instructs omission for short, with service behavior owned by the selected route.

| Field                         | Item fields                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------- |
| `search_query`, `image_query` | required `q: string`; optional `recency: unsigned integer`, `domains: string[]` |
| `open`                        | required `ref_id: string`; optional `lineno: unsigned integer`                  |
| `click`                       | required `ref_id: string`, `id: unsigned integer`                               |
| `find`                        | required `ref_id: string`, `pattern: string`                                    |
| `response_length`             | `"short"`, `"medium"`, or `"long"`                                              |

The native generated schema does not impose the local array caps. Retain the standalone client's validation bounds as an explicit request-size adaptation: query arrays 1–4, navigation arrays 1–10, domains at most 20, nonnegative integer indices/recency, and reject unknown properties. Do not invent an additional required outer field. Preserve native guidance that more than three search queries require medium or long output. Remove the local model-facing `settings.search_context_size`: native `SearchSettings` is request configuration outside `SearchCommands`, and the bridge owns safety settings. Do not expose `id`, `model`, `input`, headers/auth, or request `max_output_tokens` as model arguments.

Omit screenshot, finance, weather, sports, and time schemas and advertising. The current client cannot execute those operations. Search results and image queries return **text**, not local image bytes. Native `SearchOutput` uses the default `ToolOutput` conversion to a string; return the owned tool's text content as that string, not `{route,webRun}` or an arbitrary HTTP response object. Keep source-reference metadata and navigation IDs in bridge state, and explicitly invoke citation collection for nested results before discarding renderer details. Failed routes/requests reject.

Availability and each execution preserve current route policy: stock Codex Responses, explicitly allowlisted compatible Responses providers, or separately enabled stock fallback. Code Mode activation alone never enables personal credential fallback. Keep the tool-owned navigation state, fixed 8,000-token request budget, 15-second connection / 60-second request limits, 6 MiB HTTP body / 8 MiB process-output bounds, and no conversation/prompt/history forwarding. Those are retained integration limits, not native hosted web parity.

### `tools.view_image(args)`

Exact description: “View a local image file from the filesystem when visual inspection is needed. Use this for images already available on disk.” Required `path: string`, described as “Local filesystem path to an image file.” Native input is a non-strict object, `additionalProperties=false`. Availability requires the active model to accept image input and a supported bundled helper.

Native can conditionally expose `detail: "high"|"original"` and `environment_id`. **Omit both**: the retained helper has no resize selector or attached-environment routing. It preserves validated original PNG/JPEG/WebP bytes and converts a single-frame GIF to PNG, rejecting animation. Keep its 32 MiB input, 4096-per-axis, and 128 MiB decoder allocation limits. No data-URL input, remote lookup, or generated image descriptions.

Native JS output is `{image_url: string, detail: "high"|"original"}` (both required), not a Pi content wrapper. Convert the owned result's single image block into a data URL and return `{image_url, detail:"original"}` because the helper preserves resolution. Project the output schema's detail enum to `original` and its description to “Image detail hint returned by view_image. Returns `original` when original resolution is preserved.” Do not claim native default high resized behavior. The script can call `image(await tools.view_image({path}))`; #301 also retains the image in UI details so it is visible without manufacturing additional model output. Stock Pi may not carry the detail hint to its provider; this is separate from preserving the bytes. Missing/invalid/oversized files reject.

## Native rejection and ownership

A delegate rejection becomes a rejected JavaScript promise. An individual denied shell launch does not directly revoke another command's authorization. However, an unhandled rejection (including an awaited `Promise.all` rejection) can end the cell. `cell_actor/mod.rs` then calls `finish_callbacks`; even natural completion drains notifications, cancels the callback token, and drains tool delegates. `code-mode-host/src/peer.rs` forwards `delegate/cancel`. Thus **unfinished sibling delegates can be cancelled by cell finalization**. `Promise.all` itself does not cancel siblings. Preserve these native semantics; do not resolve denials as successful objects, patch the host for stronger isolation, or add batching advice as a workaround.

#297/#298/#299 must connect delegate cancellation to actual owned execution and pending approval invalidation. Every nested command has a unique call/authorization ID, even in a parallel batch. Authorize actual validated `cmd` arguments before process creation, never outer JavaScript. Serialize human dialogs, allow independent reviews/approved commands to proceed, recheck allowances before queued dialogs, and reject late approvals after cancellation. Stdin polling/input stays outside new command classification. Preserve the subagent broker; reuse #286's escalation seam if present.

Normal cell completion can leave a shell session whose launch delegate already returned. Explicit cell cancellation also terminates shell sessions created by that cell, even if their launch delegate has finished, while preserving unrelated cells' sessions. Distinguish host `cell/closed` from explicit user cancellation; do not kill all shells merely because an isolate completed.

Runtime state belongs to the active conversation branch. Switching between supported GPT-5.6/GPT-6 models preserves it. Leaving scope, branch navigation, session replacement, reload, and shutdown clear cells/store values and terminate owned shell sessions, with visible feedback. Restored transcripts restore display only. A missing/crashed host fails visibly without changing the tool interface. Snapshot Pi's stable dependencies before awaits; never dereference captured ephemeral `ctx` in callbacks, continuations, or timers. Lifecycle regressions must use throwing stale getters.

## Pi transport and presentation

Installed Pi **0.85.1** documentation is the API authority: `/nix/store/1dp98a4mcph9wmb2jmc20h8qvjbnryys-pi-0.85.1/libexec/pi/docs/`, specifically `models.md` “OpenAI Compatibility” and `extensions.md` “Tool Definition”, “Tool Results”, and “Error Handling”. Readable local dependency implementation was **0.85.0**, not falsely identified as installed CLI source.

Register `exec` with a single required string property `code` and `constrainedSampling: {type:"grammar", variants:{openai_lark: nativeGrammar}}`. Pi's stock Responses conversion emits a custom grammar tool when `compat.supportsOpenAIGrammarTools` is true and wraps raw input into `{code: raw}` before extension execution. The capability defaults false; unsupported transports/models keep the normal structured function `{code:string}` fallback. In that fallback replace the raw-input sentence with an instruction to put source in `code`; retain the same JS and pragma semantics. Do not enable capabilities from model-family names, invent a custom provider, or promise grammar input on every eligible route. Wait remains an ordinary function tool. SSE and WebSocket share the Responses grammar conversion.

Evidence: `node_modules/@earendil-works/pi-ai/dist/api/constrained-sampling.js` (`inferConstrainedSamplingArgumentName`, resolver), `openai-responses-shared.js` (tool conversion/custom input/history/results), and `openai-codex-responses.js` (shared request construction). There must be exactly one required string property; an optional-field schema is not the same constraint.

Pi `onUpdate` emits `tool_execution_update`, not an extra model message (`pi-agent-core/dist/agent-loop.js`). Only returned content is model-visible; `details` is rendering/state data, and a returned `isError` alone does not set Pi error status. Responses conversion concatenates text with newlines, emits supported image blocks, and excludes details. Therefore outer status/errors/notifications must be in final content as appropriate, with UI trace state kept separately. The supported failure-marker hook above follows installed `extensions.md` “tool_result” (lines 846–873); local `pi-coding-agent/dist/core/agent-session.js` forwards result details to the hook, `extensions/runner.js` merges its `isError` patch, and `pi-agent-core/dist/agent-loop.js` applies it before constructing the final tool result. A hook result patch is distinct from an ignored top-level `isError` field returned by `execute`.

Reuse the five existing renderers inside enclosing exec/wait results. Hide JavaScript by default; expansion exposes nested details, errors/images remain visible, and standalone script output is shown when no nested calls exist. Restored traces must stay bounded and must not recreate processes or tool messages. No changes to this rendering ship in #295.

## Delivery boundary

[ADRs 0001–0004](../adr/0001-codex-code-mode-scope.md) and [CONTEXT.md](../../CONTEXT.md) define the accepted scope. #296 packages the pin and generation seam; #297 owns host IPC, cells, budgets, and cleanup; #298 shares command authorization; #299 implements the five projections and aligns defaults/results; #300 registers projected definitions and narrows activation; #301 presents traces; #302 validates the complete cutover. These issues should not reopen the supported tools, model families, native cleanup contract, or prompt policy.

Keep Code Mode inaccessible until all seams work together. Preserve unrelated direct tools and additive Pi/project/skill/extension prompts. Outside supported GPT-5.6/GPT-6 families (including named variants and recognized provider prefixes), restore normal Pi core tools and remove the current standalone outside-scope web exception at cutover. Do not activate all GPT models, future GPT families, or whole configured providers.

Validation for this baseline: reproduce both JSON artifacts from the pinned Git objects, review the complete extracted schemas/semantics, and run `bun check`. No tests solely for descriptions/prompts are required. Later runtime checks must cover rejection/sibling cleanup, pending approvals, deadline/default alignment, partial patch failure, typed results, citation updates, image conversion, grammar/fallback wire output, and stale contexts; #302 records actual maintainer-route smoke coverage and unavailable routes.
