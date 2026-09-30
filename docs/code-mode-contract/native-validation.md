# Native Code Mode release validation (#372)

## Disposition

The integrated parent and SDK child adapter passes the local Pi 0.99.1 checks and
bounded Linux x64 live exercises below. This is evidence for review of
`native-codemode`, **not authorization to promote it to master**. Maintainers must
explicitly accept or close the release limitations below before calling the
migration release-ready. No V8 fallback is restored to cover a validation gap.

The integration baseline is `30374dd3` (`native-codemode@origin`, after #371).
The [native contract](native-parent.md) and amended [ADRs](../adr/0001-codex-code-mode-scope.md)
are authoritative; historical V8 smoke records are not native validation.
[Sanitized results](smoke/native-results.json) preserve actual route/check outcomes,
including failed first attempts, without credentials, provider payloads, repository
source, conversation dumps, account IDs or image data.

## Environment and boundaries

Executed on 2026-09-30 UTC: NixOS, Linux `6.18.53`, `x86_64`; Node `24.20.0`,
Bun `1.4.2`, Python `3.14.7`, TypeScript `7.0.2`, Vitest `4.1.11`, oxlint `1.86.0`,
oxfmt `0.47.0`. Pi CLI and installed `pi-coding-agent`, `pi-server`, `pi-tui`,
`pi-ai`, `pi-agent-core` and `pi-codemode` are all `0.99.1`, the supported minimum.
The package declares Bun `1.3.11`; this run uses `1.4.2`, not that exact Bun pin.

Version inventory includes `uname -srm; bun --version; node --version; pi --version`.

A legacy host exists outside the smoke environment (both user and system PATHs).
The isolated environment contains no host installation and its restricted PATH
cannot discover `codex-code-mode-host` or `code-mode-host`. It includes only the
resolved Node, Bun, Bash, coreutils and Python executable directories. The CLI
loading and focused session checks additionally use an empty HOME, fresh agent
settings and no inherited environment. Live probes retain HOME only to read the
**selected provider's** stored OAuth credential; their execution cwd/agent settings
are temporary and context discovery is disabled. This proves no discoverable-host
dependency, not that the entire workstation is an uninstalled-host OS image.

The live probes send synthetic prompts, an exact harmless shell command and a
synthetic PNG, not repository files or prior conversation. Raw local evidence stays
under `/tmp/pi-372-*`; only selected summary fields are published. No credentials
are copied into this record. The child probe's temporary auth file is mode `0600`
and is removed with its temporary execution directory.

## Compiled CLI packaging blocker (session `01a0f3b7`)

The system Nix Pi 0.99.1 executable fails even `text(6 * 7)` with
`Script sandbox failed: Cannot find module '/$bunfs/root/src/extensions/codemode/worker.js'`.
No nested calls run. The installed `llm-agents.nix` derivation compiles the CLI
and image-resize worker only; upstream's binary build also embeds the codemode
worker. CLI loading and SDK execution above did not cover this distribution seam.

The offline probe asserts the actual codemode result, not just CLI exit status:

```sh
bun scripts/native-codemode-cli-smoke.ts                    # system package: fails
bun scripts/native-codemode-cli-smoke.ts node_modules/.bin/pi # npm CLI: passes
```

The Nix package needs the same wrapper/entrypoint treatment as its image worker:

```sh
mkdir -p src/extensions/codemode
echo 'import "../../../dist/extensions/codemode/worker.js";' > src/extensions/codemode/worker.ts
bun build --compile ./dist/bun/cli.js ./src/utils/image-resize-worker.ts \
  ./src/extensions/codemode/worker.ts --outfile dist/pi
```

A temporary Linux x64 rebuild with this additional entry passes the probe and
an offline replay of the session's three parallel `exec_command` calls. The
installed system package/configuration remains unchanged: rebuild it with this
packaging fix and rerun the probe before treating compiled CLI execution as
validated. The npm CLI is a verified temporary alternative.

## Reproducible commands

Commands run from the repository root. These setup commands produce the restricted
PATH and fresh CLI settings used below (Nix store paths are machine-specific):

```sh
python3 - <<'PY'
import os,shutil
p=list(dict.fromkeys(os.path.dirname(os.path.realpath(shutil.which(x))) for x in ['node','bun','bash','cat','timeout','python3']))
print(':'.join(p));open('/tmp/pi-372-path','w').write(':'.join(p))
PY
mkdir -p /tmp/pi-372-host-free
HOST_FREE_PATH="$(cat /tmp/pi-372-path)"; env -i HOME=/tmp/pi-372-host-free PATH="$HOST_FREE_PATH" /bin/sh -c 'if command -v codex-code-mode-host || command -v code-mode-host; then exit 1; fi; node --version; bun --version; bash --version | head -1'
mkdir -p /tmp/pi-372-host-free/agent
```

The fresh `agent/settings.json` initially contains `{"defaultTools":["+tool_search"]}`.
A temporary `/tmp/pi-372-inspect.ts` registers the `release-inspect` command:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export default function (pi: ExtensionAPI) {
  pi.registerCommand("release-inspect", {
    description: "Offline loading evidence",
    handler: async (_args, _ctx) => {
      pi.sendMessage(
        {
          customType: "release-inspect",
          content: JSON.stringify({
            all: pi.getAllTools().map((t) => t.name),
            active: pi.getActiveTools(),
          }),
          display: false,
        },
        { triggerTurn: false },
      );
    },
  });
}
```

This inspector emits registration/selection evidence without a provider request;
RPC has no tool-list command. Closing stdin shuts down each loading probe.

```sh
(printf '%s\n' '{"id":"load","type":"prompt","message":"/release-inspect"}'; sleep 4) | env -i HOME=/tmp/pi-372-host-free PATH="$(cat /tmp/pi-372-path)" PI_CODING_AGENT_DIR=/tmp/pi-372-host-free/agent node node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js --offline --mode rpc --no-session -nc -ns -np --no-themes -ne -e builtin:codemode -e builtin:tool-search -e ./packages/ext/index.ts -e /tmp/pi-372-inspect.ts --model openai/gpt-6.1-sol > /tmp/pi-372-cli-dev.jsonl 2>/tmp/pi-372-cli-dev.stderr
env -i HOME=/tmp/pi-372-host-free PATH="$(cat /tmp/pi-372-path)" PI_OFFLINE=1 PI_CODING_AGENT_DIR=/tmp/pi-372-host-free/agent node node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js install "$PWD"
CLI="$(readlink -f node_modules/.bin/pi)"; (printf '%s\n' '{"id":"load","type":"prompt","message":"/release-inspect"}' '{"id":"commands","type":"get_commands"}'; sleep 4) | env -i HOME=/tmp/pi-372-host-free PATH="$(cat /tmp/pi-372-path)" PI_CODING_AGENT_DIR=/tmp/pi-372-host-free/agent node "$CLI" --offline --mode rpc --no-session -nc -ns -np --no-themes -e /tmp/pi-372-inspect.ts --model openai/gpt-6.1-sol > /tmp/pi-372-cli-package.jsonl 2>/tmp/pi-372-cli-package.stderr
HOST_FREE_PATH="$(cat /tmp/pi-372-path)"; env -i HOME=/tmp/pi-372-host-free PATH="$HOST_FREE_PATH" bunx vitest run packages/ext/native-codemode.test.ts packages/ext/codex-adapter/native-registration.test.ts packages/ext/subagents/test/agent-capabilities-e2e.test.ts packages/ext/subagents/test/v2-exposure.test.ts
bunx vitest run packages/ext/codex-adapter/code-mode-activation.test.ts packages/ext/codex-adapter/apply-patch.test.ts packages/ext/codex-adapter/exec-command.test.ts packages/ext/codex-adapter/web-run.test.ts packages/ext/codex-adapter/view-image.test.ts packages/ext/usage-dashboard.test.ts packages/ext/bash-gate/command-authorization.test.ts
bun --bun vitest run scripts/subagents-route-smoke.test.ts
bun run typecheck
bun check
```

The installed-package probe uses Pi's actual `install` command with the local
package directory/manifest, not an explicit extension file. `get_commands` reports
`origin: package` for its commands. Both CLI paths register one native `codemode`
and `tool_search`, select them and retain direct V2 controls. Pi warns that its
replaceable codemode builtin is omitted because the adapter registers that name;
this is intentional factory replacement, not a second runtime or duplicate tool.
No MCP server is configured or auto-connected. These are loading checks, **not CLI
provider execution or evidence that CLI loading is inherited by SDK children**.

## Behavioral evidence

The final focused four-file restricted-PATH run passes **54 tests**, including the
new usage and restored patch/image checks (the initial slice run passes 53). The separate
seven-file capability/renderer/auth run passes **109 tests**. The smoke checker
suite passes **3 tests**. Full `bun check` runs lint, repository formatting,
typechecking, all package tests under Node and all script tests under Bun: **117
package files / 1,520 tests pass (4 skipped)** and **4 script files / 34 tests pass**.
The four skips are existing opt-in live print-mode scenarios, not host-migration
tests; the bounded route probes below are separate executions, not those scenarios.

The V2 probe requires one actual child launch and one approval. Native success
requires typed `exit_code: 0` and exact stdout; ordinary bash requires exact text
output, not a command heading or script echo. Header-only/running results and
ordinary nonzero exits fail its regression. Both captured final V2 runs pass a
replay through this stricter check; that replay is not a new provider request.

| Registered/session seam                                                    | Observed evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `native-registration.test.ts` (real parent session, scripted model stream) | Permitted discovery and typed parallel shells, ordinary exit 7 as a value, raw/object patch success, partial mutation failure/recovery, explicit versus stored-only images, script-only output and failures after output; returned background shell IDs poll in later scripts. Web fixture returns text/citations once and revoking its route rejects execution; this fixture is not live web acceptance.                                                                                                                         |
| `native-codemode.test.ts`                                                  | Script search/description does not activate declarations; separate model-facing `tool_search` activates an eligible deferred declaration. Hidden/model-only tools remain inaccessible. A usage-bearing nested tool persists only in the enclosing result, with one nested record, one top-level tool call/result and exactly 17 nested tokens plus 4 synthetic assistant tokens, cost 0.25.                                                                                                                                       |
| `agent-capabilities-e2e.test.ts` (production `openAgentSession`)           | Explicit SDK factories initialize and reload without duplicate tool errors; eligible children discover/call shell and poll it host-free. Parent ceilings, read-only selections and omitted owned tools survive discovery, search, model switches and reload. Adapter-disabled children retain ordinary tools. Real stale contexts throw before late approvals are released; cancelled/shutdown work never creates the forbidden file.                                                                                             |
| Parent authorization/lifetime and shared gate suites                       | One serialized approval per actual parallel shell launch, unique nested IDs, cancellation rejects late decisions, pinned launch context; branch/start/shutdown retire owned processes/store, unsupported scope restores tools. Supported-model selection and GPT-6.1 eligibility remain bounded. Pending siblings can be cancelled on native failure; already-returned shell sessions survive ordinary script errors, whereas explicit cancellation kills only that script's launches. No stronger sibling guarantee is promised. |
| `v2-exposure.test.ts`                                                      | Stock parent/child provider declarations preserve six independent model-only V2 controls, including adapter-disabled sessions and provider switches; collaboration is never script-callable. These are payloads stopped before transport.                                                                                                                                                                                                                                                                                         |
| Owned tool and usage suites                                                | Concrete truncation, TTY/polling, process cleanup, patch ordering/recovery, image validation, route/auth destination and explicit-only fallback policies remain covered. Direct OpenAI OAuth/API keys do not acquire legacy web/usage access.                                                                                                                                                                                                                                                                                     |

### Presentation inspection

The registered native renderer is invoked on JSON-round-tripped results in collapsed
and expanded mode at 80 columns: command/error rows, standalone text, emitted patch
success values and explicit PNG textual fallback remain visible after restoration.
The image check uses `showImages: false`; it does not prove terminal pixel display.
Owned patch/shell suites separately inspect scanline styles, widths, terminal-control
sanitization, collapse/expand and restored partial failure/diffs.

The accepted native renderer is inherited from Pi: operation names plus bounded
argument previews, not the old owned nested renderers. A patch emits its structured
success value only when the script calls `text`; nested syntax-colored diffs are
not restored. Collapsed native output retains 5 lines and 8 nested rows; expanded
shows retained details, not discarded arguments/errors (200/500-character caps).
Native explicit images reach enclosing result content and both live supported
routes below accept the following request containing that image. Restored display
never restarts a worker, shell or stored value. Manual terminal image/layout review
remains a release limitation rather than an inferred pass under rendering guidelines.

## Live routes and architectures

These exact commands use the existing bounded probes, with no route substitution:

```sh
env PATH="$(cat /tmp/pi-372-path)" bun scripts/code-mode-route-smoke.ts openai-codex/gpt-6.1-sol /tmp/pi-372-host-free-live-codex
env PATH="$(cat /tmp/pi-372-path)" bun scripts/code-mode-route-smoke.ts openai/gpt-6.1-sol /tmp/pi-372-host-free-live-openai
env PATH="$(cat /tmp/pi-372-path)" bun scripts/subagents-route-smoke.ts openai-codex/gpt-6.1-sol /tmp/pi-372-live-v2
env PATH="$(cat /tmp/pi-372-path)" bun scripts/subagents-route-smoke.ts openai/gpt-6.1-sol /tmp/pi-372-live-v2-disabled adapter-disabled
env PATH="$(cat /tmp/pi-372-path)" bun scripts/subagents-route-smoke.ts openai-codex/gpt-6.1-sol /tmp/pi-372-live-v2-native
env PATH="$(cat /tmp/pi-372-path)" bun scripts/subagents-route-smoke.ts openai/gpt-6.1-sol /tmp/pi-372-live-v2-disabled-retry adapter-disabled
env PATH="$(cat /tmp/pi-372-path)" bun scripts/code-mode-route-smoke.ts openai-codex/gpt-6.1-sol /tmp/pi-372-live-web explicit
```

| Route / scenario                                                    | Outcome and scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Linux x64, legacy `openai-codex/gpt-6.1-sol`                        | Executed/pass: native script-only 42, parallel shell/image, one exact-command approval, explicit image, background shell polling; 4 provider requests. Every declaration is native `codemode` with custom Lark grammar.                                                                                                                                                                                                                                                                                                              |
| Linux x64, direct `openai/gpt-6.1-sol` ChatGPT OAuth                | Executed/pass: same bounded exercise and grammar acceptance, 4 requests. This does not establish legacy usage/search rights for direct OAuth.                                                                                                                                                                                                                                                                                                                                                                                        |
| Legacy route native SDK child + direct V2                           | Final executed/pass, 12 captured parent/child requests: one approved native shell, independent progress/final mail, completion, settled interrupt and same-task recall without a marker reminder. First run falsely fails the old checker despite completing the exercise: it expects retired exec/wait traces and rejects valid relative task references. The probe now checks native launch results and controller-resolved targets; focused regression tests reproduce both defects. The original failed result remains recorded. |
| Direct route, adapter-disabled SDK child + direct V2                | First executed/fail: provider HTTP 503 `subscription_sharing_user_unavailable` interrupts the parent after child shell/progress. One bounded retry executes/passes all 13 checks, 12 captured requests, one approved ordinary bash launch. No provider/credential fallback or automatic retry is introduced.                                                                                                                                                                                                                         |
| Legacy route, explicit web discovery/search                         | Executed/pass: model reads full supported browsing/citation help before web execution, then searches its selected authorized route. This is live web acceptance, separate from the helper fixture.                                                                                                                                                                                                                                                                                                                                   |
| Direct OpenAI subscription web/usage                                | Unavailable by policy, not tested as a live supported endpoint; preserve #365's documented upstream limitation and isolation.                                                                                                                                                                                                                                                                                                                                                                                                        |
| OpenAI API key; custom Responses proxy; other eligible GPT variants | Live smoke skipped: no alternate credential/route is selected for this record. Eligibility and destination policies have local behavioral coverage, not live acceptance on every variant.                                                                                                                                                                                                                                                                                                                                            |
| Anthropic live V2                                                   | Unavailable: no stored Anthropic credential. Local stock-payload/V2 tests are not a substitute.                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Linux arm64                                                         | Skipped: no ARM execution in this run. Retained arm64 executables/provenance are not execution evidence; no x64 or historical QEMU pass is relabeled ARM validation.                                                                                                                                                                                                                                                                                                                                                                 |
| Other operating systems                                             | Unavailable for the retained Linux-only owned helpers; no new platform support is claimed.                                                                                                                                                                                                                                                                                                                                                                                                                                           |

Stock-provider construction is independently exercised for Responses, Codex
Responses and Completions with grammar enabled **and disabled**, asserting native
names/argument fallback and stable declarations across requests. The live probes
above prove selected **grammar** routes accept their actual payloads; live
structured fallback and Completions acceptance remain unexecuted.

## Deletion and provenance review

Reviewed integration scope from epic baseline `15d049b948847729034fbff1d09c41d7f0e08c3b`
to `native-codemode@origin`: 205 files, 2,984 additions / 42,188 deletions. The host
vendor, install/build/smoke assets, IPC/process/connection machinery, cell/delegate
supervision and obsolete host-only tests are removed. A production-source search
finds no `codex-code-mode-host`, `PI_CODE_MODE_HOST`, `CodeModeRuntime`,
`yield_control`, or old `tools.exec`/`tools.wait` dispatch. All eight Linux x64/arm64
shell, patch, web and image executables remain, with their separate notices and
source provenance. Historical host ADRs/evidence stay explicitly historical.

Retained owned-tool provenance regenerates byte-for-byte, without a host or Rust
description builder, using these exact commands:

```sh
python3 scripts/extract-code-mode-contract.py /home/jt/projects/codex /tmp/pi-372-owned-tool-contract-evidence && cmp docs/code-mode-contract/source-manifest.json /tmp/pi-372-owned-tool-contract-evidence/manifest.json && cmp docs/code-mode-contract/native-text.json /tmp/pi-372-owned-tool-contract-evidence/native-text.json && python3 scripts/generate-code-mode-contract.py /tmp/pi-372-owned-tool-contract-evidence /tmp/pi-372-owned-tool-contracts.json && cmp packages/ext/codex-adapter/owned-tool-contracts.generated.json /tmp/pi-372-owned-tool-contracts.json
```

## Release limitations requiring maintainer disposition

- ARM execution, a fully host-uninstalled OS image, packaged npm archive loading
  (the installed local manifest is tested), and the declared Bun 1.3.11 runtime
  are not validated here. Run those environments or explicitly accept the gap.
- Manual live terminal collapsed/expanded layout and pixel-image display are not
  exercised; tests inspect inherited native text rendering and owned renderers.
  Accept the native patch/preview tradeoff or complete terminal inspection before
  promotion; do not silently claim historical nested-diff parity.
- Live Completions/structured fallback, API-key/custom routes, other supported
  model variants and Anthropic V2 remain skipped/unavailable as enumerated above.
  The observed transient direct-subscription 503 remains an external availability
  limitation even though the bounded retry passes.
- Direct OpenAI subscription usage/web remain intentionally unsupported under
  [#365](openai-compatibility.md). No endpoint compatibility is inferred and no
  personal-account fallback is enabled by this validation.
