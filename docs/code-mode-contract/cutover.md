# Code Mode cutover validation (#302)

The default adapter now selects Code Mode for GPT-5.6/GPT-6 families. The false integration gate, legacy registration/activation, structured prompt guidance and their obsolete tests are removed. `codexAdapter.providers` no longer selects models; unknown old config keys remain ignored under the existing config parser. Web-route configuration and independent disable remain supported. RTK removal is the prerequisite ancestor `6dc4c867`.

## Reproducible integration checks

A real host is required to exercise the native tests. The normal suite can skip native integration if no manual installation or retained local build exists, so supply the host explicitly when validating this cutover:

```sh
export PI_BITES_TEST_CODE_MODE_HOST="$PWD/packages/ext/codex-adapter/vendor/code-mode/target/x86_64-unknown-linux-musl/release/codex-code-mode-host"
bunx vitest run packages/ext/codex-adapter/code-mode-registration.test.ts packages/ext/codex-adapter/code-mode-nested.test.ts packages/ext/codex-adapter/code-mode-runtime.test.ts packages/ext/codex-adapter/code-mode-transport.test.ts
bun check
```

Final `bun check` passed on 2026-09-11: 1,342 main-suite tests passed (four pre-existing skips), then 83 Bun tests passed. The real host was present; no Code Mode integration tests skipped. Lint, formatting and typechecking passed.

The web integration tests require permission to bind a loopback HTTP server, but never use external credentials or hosted search. Both Node and Bun run the real-host integration files in `bun check`.

| Boundary                                             | Exercised behavior                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Default adapter registration + real host + real gate | Model-visible exec/wait, preserved custom tools, nested approval/streaming/final updates, native yields, failed/restored render snapshots, supported switches, tree reset, stale throwing ctx getters, explicit disable and tool selection                                             |
| Default registration lifecycle                       | Replacement, reload, shutdown and leaving scope terminate real owned processes; old cells/values cannot resume. Missing host rejects visibly while exec/wait stay selected                                                                                                             |
| Real host + five owned tools                         | Foreground/nonzero/background/TTY shells, input and polling, deadlines/truncation, cell-owned cleanup, shared patch ordering and partial failure, native image emission without duplicate model output                                                                                 |
| Real host + shared bash gate/Auto Mode               | Per-call audit IDs; all-settled denial isolation; unhandled aggregate finalization cancels sibling approval; queued session allowances; permitted work proceeds; reviewer approval/denial/failure, UI escalation errors, cancellation and late decisions never launch blocked commands |
| Real host + bundled web helper + local HTTP endpoint | All five operations, shared navigation identity, citation transformation, explicit-only request payloads and execution-time route denial; separate route-failure tests assert no provider fallback                                                                                     |
| Runtime and presentation suites                      | Crashed host, cancellation during startup/approval/wait, bounded cells/output/store/trace data, standalone output, errors and images, restored display without resurrected execution                                                                                                   |
| Stock Pi transport                                   | Responses, Codex Responses and Completions payloads with grammar enabled and disabled; no provider override                                                                                                                                                                            |

Auto Mode integration supplies deterministic reviewer decisions at the external reviewer boundary; it does not claim a live automated-review model approval. The live smoke below uses the actual shared manual gate with a scripted UI approving only one exact harmless command. Real terminal interaction remains a manual check.

## Native artifacts and contract fidelity

The selected Codex pin remains `25af12f7e61572b0bc18ddb1008be543b91519b0` (`rust-v0.145.0`); conversion reference remains 3.0.31 / `94eb6c0745e2f516bf19603f912f7b6478b43355`. No native source, generated contract, lockfile or executable changes were needed. The only vendor inventory change is the packaging README describing the now-active dependency.

The [packaging record](../../packages/ext/codex-adapter/vendor/code-mode/README.md) documents the accepted manual release installation, checksums, retained sources/licenses, both locked cross-build recipes and their validation. This supersedes the epic's original bundled-host wording, as accepted in ADR 0002. Existing native helpers remain bundled; startup never downloads a host.

On 2026-09-11 (America/Toronto), retained x64 and arm64 musl builds both passed `scripts/code-mode-smoke.py`: protocol v1, V8 `text(6 * 7)`, session shutdown and clean exit. x64 ran directly; arm64 ran with QEMU 11.1.0. Earlier packaging validation records 122 locked native tests for each target and official-release smoke for each architecture. This cutover reran runtime smoke, not the unchanged native builds; no physical arm64 hardware validation is claimed.

Regeneration using `scripts/extract-code-mode-contract.py ~/projects/codex NEW_EVIDENCE_DIR` and `scripts/generate-code-mode-contract.py` followed by formatting reproduced the checked-in contract byte-for-byte. The generator invoked its locked offline native description builder. The supported fields, wording, grammar, defaults and projections remain those reviewed in the [baseline](README.md) and [activation record](activation.md). No new deviation, prompt-only test, model template, or promise-batching advice was introduced.

## Actual route smoke

Run the retained probe from the repository root with the host installed and the intended route already configured/authenticated in Pi:

```sh
bun scripts/code-mode-route-smoke.ts openai-codex/gpt-5.6-sol /tmp/code-mode-smoke-sol
bun scripts/code-mode-route-smoke.ts openai-codex/gpt-6-astra /tmp/code-mode-smoke-astra
```

The probe uses the repository's stock Pi SDK, existing model catalog, and only the named provider's stored credentials in memory. It creates a temporary cwd and image, loads the production adapter and bash gate, preserves default builtin selection, and captures only emitted tool payloads plus synthetic smoke results. It sends a synthetic prompt to that exact provider/model and approves only `printf code-mode-approved`; all other approval requests are denied. It sends no repository files or conversation history. No route substitution or personal fallback is enabled. Evidence is saved in the supplied directory and temporary execution files are removed. An absent model is reported as unavailable. Network access is required for available routes.

Recorded on 2026-09-12 03:25 and 03:34 UTC (2026-09-11 local), using repository SDK **0.85.0**; installed Pi CLI documentation is **0.85.1**:

| Actual route               | Result                                                                                                                                                                 |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `openai-codex/gpt-5.6-sol` | Passed: normal `42`, yield and wait with `after-yield`, exactly one shared-gate approval, native command output, emitted local image. Six provider requests, no errors |
| `openai-codex/gpt-6-astra` | Passed: normal execution, yield/wait, exactly one shared-gate approval, native command output and emitted image. Six provider requests, no errors                      |
| Work/custom providers      | No custom model configuration found or supplied; unavailable for live verification                                                                                     |

All twelve requests across Sol and Astra emitted identical tool payloads: `exec` as a custom Lark grammar tool and `wait` as a function with the native schema. The [captured tools](smoke/openai-codex-tools.json) record complete descriptions, schema and grammar; [results](smoke/results.json) record checks and availability. The original capture SHA-256 is `fec9d67604940661414167178612fd674bc05c812f070bcc11c20c6b1f624817` (repository formatting may alter whitespace only). Actual work-route behavior remains unverified because no work/custom route was configured.

For a manual terminal smoke, start `bun run dev` with the host installed, select the actual eligible route, and request the same four operations. Confirm recognizable nested rows, hidden raw JavaScript, expanded details and image display. Run a harmless command that your gate requires approval for; deny once and confirm it never executes, then allow an intended command. Yield a long-lived cell, switch between supported models, use `/tree`, then `/reload`; confirm state is retained only across supported switches and old waits cannot resume after resets. Temporarily disable `codexAdapter` and confirm normal tools return. Restore a saved transcript and confirm display persists without running commands again.
