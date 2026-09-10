# Internal Code Mode runtime

Implemented for #297, using the [contract baseline](README.md). This runtime is
not registered with Pi and exposes no new model tools. The validated/authorized
five-tool dispatcher (#299), activation (#300), and nested presentation (#301)
remain separate integration steps.

## Call boundary

`packages/ext/codex-adapter/code-mode/runtime.ts` exports `CodeModeRuntime`:

- `execute(source, signal?, tools?)` parses the native first-line pragma and evaluates
  JavaScript in the pinned host. Defaults are 10,000 ms and 10,000 output tokens;
  null pragma fields use defaults, and zero/nonnegative safe integers are accepted.
  Each cell snapshots its supplied tool set (or the constructor defaults), so
  new executions can change capability definitions without clearing stored values.
- `wait(cellId, yieldTimeMs = 10000, signal?)` consumes only new output. Concurrent
  waits on one cell are rejected; different cells can be observed independently.
- `terminate(cellId)` synchronously invalidates delegates and owned shells before
  asking the host to terminate. A missing/consumed ID returns the native failed
  result with `missingCell: true`.
- `shutdown()` immediately invalidates dispatch, terminates owned shells, kills
  the dedicated host, and awaits process closure. It is idempotent. Instances
  never restart after shutdown, crash, startup failure, or resource overflow.

Results preserve the native yielded/result/terminated distinction, text/images,
script error text, and explicit execution output budget. Output formatting and
per-observation token truncation belong to #300, not this internal transport.
The native service ignores the execute output budget, and V1's optional wire
field is only i32; the bridge therefore sends null and carries the full safe
integer budget in its result. It does not silently cap large native pragmas.
Audio responses are rejected. Notifications produce immediate UI callbacks and
are prepended once to the next returned observation. Callbacks must use stable
snapshots; they are not extra model-visible Pi tool messages.

Public cell IDs are `<runtime UUID>:<native cell ID>`. The host restarts its own
counter at `1`, so exposing the bare counter would let a transcript's old ID
address an unrelated replacement cell. The prefix also keeps cells visibly
separate from numeric shell session IDs. Delegate call IDs include this runtime
and cell identity. Unknown prefixes fail locally without launching a host.

## Dispatcher and shell ownership

`RuntimeTool` supplies explicit callable definitions and an `invoke(input, call)`
implementation. No third-party executor discovery, Notebook registry, provider
registry, source rewriting, or direct-tool routing is included. The dispatcher
must validate constructed arguments, check current tool availability, authorize
actual commands, and recheck `call.signal` after every approval await and before
launch. It must honor cancellation and never capture a Pi extension context.

The runtime passes a separate `AbortSignal` for each delegate. A rejection stays
a JavaScript rejection. Native module finalization cancels unfinished delegates,
including siblings after an unhandled aggregate rejection; completed delegates'
signals remain untouched. The bridge does not extend isolate lifetime, turn
denials into successful values, or special-case `Promise.all`.

For shell launches, supply the existing manager's `terminateSession` and
`onSessionExit` methods, and call `call.ownShell(sessionId)` as soon as an ID is
known, including partial exec updates. IDs must identify newly created shells,
not an existing process being polled with `write_stdin`. Late registration after
cancellation terminates the alleged new shell and throws. Registration never
transfers ownership from another cell.

Normal completion retains shell ownership while leaving resumable processes
running. Explicit cell cancellation terminates that cell's shells, including
those whose launch delegate already returned. Runtime invalidation terminates
all shells it owns, including completed cells' shells, without shutting down the
shared shell manager or affecting unrelated cells. Exit events release retained
ownership. The existing shell manager remains responsible for process-group
termination and escalation.

## Lifecycle hooks and context safety

`code-mode/lifecycle.ts` exports `CodeModeLifecycle`. It creates a runtime lazily
and offers the hooks the activation layer should call:

| Pi event                  | Owner method                   | Effect                                                                     |
| ------------------------- | ------------------------------ | -------------------------------------------------------------------------- |
| `session_start`           | `sessionStart(ctx, supported)` | Invalidate any prior generation; synchronously snapshot cwd/session ID.    |
| Successful `session_tree` | `branchChanged()`              | Clear cells, stored values, output, and owned shells.                      |
| `model_select`            | `modelSelected(supported)`     | Leaving supported scope clears state; supported-to-supported preserves it. |
| `session_shutdown`        | `shutdown(reason)`             | Covers replacement, reload and quitting; clears all live state.            |

Eligibility is supplied by #300's matcher, not guessed here. Reset after
successful branch navigation, not cancelable `session_before_*` events or
ordinary leaf growth. A caller obtains `current()` once and retains that runtime
generation for the operation. Do not reacquire a new generation inside old
promise continuations. No transcript fields are accepted to restore live state.

The options factory receives only frozen primitive `SessionSnapshot` values.
It must build tools and callbacks from stable dependencies, not retain the
original `ctx`. The runtime's delegates, timers, host messages and continuations
never receive or dereference a Pi `ExtensionContext`. Regression tests use
throwing getters after startup and exercise post-yield delegates and every
invalidation path.

Grounding: installed Pi 0.85.1 `docs/extensions.md`, “Long-lived resources and
shutdown”, “Session Events”, “model_select”, “ctx.signal”, and “Session replacement
lifecycle and footguns”; `docs/sessions.md`, “Branching with /tree”. Repository
Pi 0.85.0 source corroborates the sequence: `session_shutdown` precedes runner
invalidation, and `session_tree` follows successful leaf replacement.

## Retention and failure bounds

| Resource                                                        | Bound / cleanup                                                                         |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Live or unconsumed cells, including pending starts              | 64; consuming a terminal result releases its slot.                                      |
| Pending operations / observations                               | 256; completion, cancellation or host failure releases them.                            |
| Unsettled delegate invocations                                  | 256, including cancelled calls whose dispatcher has not settled.                        |
| Owned resumable shells                                          | 256; shell exit releases ownership.                                                     |
| Notification output awaiting an observation                     | 256 messages / 1 MiB per cell; overflow fails the runtime visibly.                      |
| IPC frames                                                      | Native 64 MiB limit in both directions.                                                 |
| Queued stdin writes                                             | 128 MiB; overflow fails visibly.                                                        |
| Host stderr                                                     | Last 16,384 characters.                                                                 |
| Host resident memory, including native output and stored values | 512 MiB watchdog, sampled every 100 ms; overflow kills the host and clears the runtime. |
| Startup                                                         | Five seconds across protocol negotiation and session opening.                           |
| Execute-start / terminate acknowledgement                       | Five seconds; does not limit JS execution or wait duration.                             |

No completed transcript or rendering history is retained here. The native host
has no per-store-value or output-memory limit in this protocol. Its RSS watchdog
is coarse containment, **not a hard allocation cap**: memory can overshoot
between samples, and V8 virtual-address reservations are not counted. It is not
Codex sandbox enforcement. It leaves the pinned native source and completion
semantics unchanged. `hostLimits` allows deterministic failure tests and explicit
embedding limits; it is not advertised as a model tool parameter.

Failures reject all outstanding requests, abort pending delegates, terminate
owned shells and surface an actionable error. There is no tool-dialect fallback
or automatic host restart; `/reload` or explicitly disabling the adapter remains
the recovery path. Killing the dedicated host also clears native `store`/`load`
values without copying them into Pi state.

## Verification

The real-host suite discovers an explicitly supplied test binary, the manually
installed dependency, or the retained workspace's `target/release` build, in that
order. Without any host it reports those integration tests as skipped; the IPC
failure fixtures still run. `bun check` runs these focused runtime/connection
suites under both Node and Bun: Bun reports failed process startup differently,
so the spawn event must precede the handshake write, and every failed handshake
promise must already have a rejection handler. CI/integration validation should supply a verified
host explicitly so absence cannot silently skip the real-host checks:

```sh
PI_BITES_TEST_CODE_MODE_HOST=/absolute/path/to/codex-code-mode-host bun check
```

For #297, the focused suite ran against the unmodified official Linux x64 release
host and the local build of the pinned source. It exercises fresh isolates,
store/load, pragma semantics, incremental waits, errors, notifications, missing
IDs, explicit cancellation, native rejection/finalization, late approvals, real
shell ownership, lifecycle resets, stale getters, startup failures, host crash,
protocol errors and resource overflow. A separate Bun smoke check confirmed that image content survives a script
error. This change modifies no Rust sources or artifacts. It does not claim arm64 runtime validation or the model-route smoke
exercise reserved for the integrated cutover.
