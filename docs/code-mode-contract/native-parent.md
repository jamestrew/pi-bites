# Native parent adapter (#369)

Parent GPT sessions use Pi 0.99.1's public `createCodemodeExtension()` factory and
native `codemode` tool. This supersedes the parent exec/wait runtime described in
[the baseline](README.md) and [activation history](activation.md). SDK children
still use `code-mode/registration.ts` until #370; their host and tests remain.
There is no selectable runtime, renamed native tool, or exec/wait emulation.
The factory uses `models: false`: model-catalog/classifier helpers are outside this migration.

## Selection and discovery

The bounded GPT-5.6/GPT-6/GPT-6.1/Sol scope and #365 route isolation are unchanged.
The native factory replaces Pi's replaceable CLI builtin at load time. The adapter
selects native codemode by default only within its permitted registry/selection.
Explicit `-codemode`, plain default-tool selections omitting it, SDK/CLI registry
restrictions, and removal of the active tool are respected. Unsupported models or
an explicitly disabled adapter restore displaced core tools.

Shell requires selected `bash`; patch requires `edit` or `write`. Inactive owned
tools are **hidden**, not merely removed from active declarations: native
`codemode`/`deferred` exposure would otherwise make them callable. Availability is
checked again at execution. Enabled tools use codemode exposure; unrelated tools
keep their exposure. V2 collaboration is model-only and never script-callable.
Child permissions recover the parent's underlying core capabilities, with the
legacy exec/wait entrypoints retained only for the child migration boundary.

Native `on` mode is deliberate: `only` would hide unrelated direct tools and still
would not hide codemode/deferred tools activated by search. Script `searchTools`,
`describeTool`, and `ALL_TOOLS` discover permitted tools without changing model
declarations. Separately enabled `tool_search` may activate permitted owned tools
as direct declarations. It cannot recover hidden capabilities. Full supported web
operations, citation and word-limit guidance come from the retained pinned web
description; initial browsing triggers and explicit credential policy remain.

## Script values

```js
const shell = await tools.exec_command({ cmd: "printf hello", login: false });
text(shell.output);
text(shell.exit_code);
text(await tools.apply_patch({ input: "*** Begin Patch\n...\n*** End Patch" }));
// The existing raw patch string also works through Pi's prepareArguments hook.
text(await tools.web_run({ search_query: [{ q: "query" }] }));
image(await tools.view_image({ path: "image.png" }));
```

Shell/stdin return typed output, timing, exit code and optional session ID fields;
ordinary nonzero exits remain inspectable values. Validation, authorization,
startup and helper-operation failures reject. Patch success returns mutation lists
and fuzz information, not renderer snapshots. Partial failures reject with the
existing applied-file/recovery feedback and are native error results. Web returns
text including citation markers; citation collection happens once in the concrete
executor. Images return an original-resolution data URL; explicit `image()` emits
it. Output schemas describe those programmatic values, not UI details.

Native scripts allow awaited parallel calls and return once, on completion. There
are no live cell IDs, outer waits, yielding promises, notifications, timers or V8
pragmas. Shell `yield_time_ms` still controls the initial process observation;
returned session IDs can be polled in later scripts. Native output budgets and
error text replace the old output headers and helper contract.

## Authorization and lifetime

Each actual validated shell launch calls the existing shared bash-gate policy
once, inside execute, using Pi's unique nested call ID and per-call cancellation
signal. The ordinary hook delegates exec_command authorization to this boundary;
it still gates core bash normally. Launch cwd/shell/login/TTY are pinned before
approval. Independent reviews proceed concurrently; human dialogs serialize and
recheck allowances. Cancellation rejects late approval before process creation.
Stdin remains outside command classification.

Pi aborts **pending** nested calls on success, failure, timeout or cancellation.
Completed launch calls are no longer pending: an unhandled script error does not
kill shells whose launch already returned. Explicit user cancellation additionally
terminates shells launched by that script, not unrelated sessions; normal completion
preserves them. Tests cover both distinctions rather than promise V8 fidelity.

Branch navigation, session start/replacement, leaving scope, reload and shutdown
abort the adapter generation and terminate owned shells. Known native JSON store
keys are cleared through the documented `codemode-store` entry format and public
`CodemodeStoreEntryData`; no private store or second sandbox is introduced. Native
writes commit only on successful scripts. Saved display never restores resources.
Stable dependencies are captured before awaits; cancellation tests invalidate real
Pi contexts and assert their getters throw before releasing late approval.

## Presentation and context

Pi owns nested hooks, parent IDs, bounded persistence, usage and native rendering.
The adapter does not reproduce its old trace engine or error-result hook. Native
rows show operation names/argument previews and errors; expanded views show retained
details. Script-only output and explicit images remain visible. The native renderer
bounds collapsed scripts/calls/output (10/8/5 lines), argument previews (200 chars)
and errors (500 chars); it does not embed full owned tool renderers or restore their
old layout. Owned renderers still serve direct declarations activated by search.

Skill loading uses native codemode and emits shell output. Prompt composition is
additive; `/context` uses the same preview including browsing guidance. Native
loadout preparation owns callable-tool declarations and descriptions. The adapter
observes and forwards its synchronous preparation unchanged, passing those native
descriptions to `/context` while codemode is active. It does not regenerate
declarations or maintain another tool registry. Other extensions can still override
descriptions later, and provider-specific serialization remains the estimate
accuracy ceiling. No old exec/wait description is active in the parent.

## Verification and limits

`native-registration.test.ts` drives real registered sessions without a V8 host,
including all five capabilities, permissions, approvals/cancellation, store/shell
lifetime, script errors, discovery/search and restored native rendering. Existing
concrete tool tests remain. V2 exposure tests capture actual stock provider payloads
before transport for parents and still-legacy children. The host suites explicitly
import child registration, rather than pretending to validate the native parent.

Evidence is offline on Linux x64 with Pi 0.99.1. Web transport is an injected native
helper fixture, not a live service. No live provider acceptance, subscription web
route, arm64 execution or migrated SDK child runtime is claimed; those remain the
epic's separate validation/migration work.
