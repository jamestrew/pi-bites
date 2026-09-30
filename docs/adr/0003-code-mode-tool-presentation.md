# Present nested operations as ordinary tools

Status: Accepted (2026-09-09), epic [#294](https://github.com/jamestrew/pi-bites/issues/294). Contract finalized by [#295](https://github.com/jamestrew/pi-bites/issues/295); implemented through #296–#302. See [cutover validation](../code-mode-contract/cutover.md) for evidence and live-route limitations.

Source definitions and supported deviations: [Code Mode contract baseline](../code-mode-contract/README.md).

Reuse the five tools' existing renderers inside Code Mode results and hide raw JavaScript by default, preserving recognizable commands, patches, and other tool activity. Expansion exposes nested details; errors and images remain visible, and explicit script output is shown when there are no nested calls to display. This follows upstream's ordinary-tool presentation while avoiding its potentially empty display for successful standalone computations; UI visibility remains separate from model-visible output.

Render child traces inside the enclosing `exec`/`wait` result; do not manufacture independent Pi tool messages. Pi partial updates are UI events. Native yields and final results carry model-visible text/images, including queued notification text. Restored display details cannot restore live cells, stored values, or shell sessions. Bound retained trace data and keep images/error details usable under text truncation.

## Native parent amendment (#369)

For parent sessions, the accepted [native parent contract](../code-mode-contract/native-parent.md)
supersedes runtime-specific statements above: use Pi 0.99.1 native `codemode`,
registry discovery, one-shot finalization and native nested rendering/persistence.
No parent V8 host, live cells or exec/wait facade remain. Keep the bounded model
scope, concrete capabilities, shared per-launch authorization and route restrictions.
The child path retains this historical host contract until its separate migration.

## Native SDK child amendment (#370)

The native amendment above also applies to SDK children. Parent and child sessions
share native registration, one-shot execution, ownership cleanup and per-launch
authorization. Explicit SDK builtin factories and the child's registry ceiling keep
parent permissions separate from discovery. Direct V2 collaboration remains
independent; see the [native adapter contract](../code-mode-contract/native-parent.md).
The historical host code/tests await separate retirement, not a selectable fallback.
