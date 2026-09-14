# Nested collaboration presentation and lifecycle

Issue #309 builds on #308's shared V1 controller and owned renderers. All five
collaboration operations render as child traces inside `exec`/`wait`; their native
structured values remain separate from display details. Raw JavaScript stays hidden.

Spawn metadata belongs to the tool row's `context.state`, not a registration-wide
call-ID cache. Replaying two observations of one call cannot change each other's
model/role/error metadata, and evicting a trace releases its display state. Execution
returns effective model/reasoning in result details; it does not maintain a second
presentation cache. Collapsed failed spawns keep the expansion hint below the error.

## Regression evidence

`packages/ext/codex-adapter/code-mode-subagents.test.ts` runs against the bundled
native host with a controlled child-session loader (no model credentials):

- All five semantic child rows survive JSON restoration into a fresh controller
  with no live agents, at collapsed/expanded and narrow terminal widths.
- A resumed outer wait takes ownership of the nested wait row without duplicating
  the preceding exec's row. Rendering does not manufacture Pi tool results.
- Cell failure and wait cancellation retain committed, controllable children.
- Tree navigation cancels old agents, suppresses cross-branch finals, and disposes
  a late initialized session exactly once.
- A late nested resume is unpublished, disposed once, and releases its reservation
  so an explicit retry can recover the conversation. Old cells remain unavailable.
- Parallel actual child commands pass through the existing bash-gate broker with
  distinct command audit IDs. Navigation cancels pending Auto Mode reviews;
  late approvals cannot launch either command, including with throwing old ctx
  getters.
- Existing scenarios cover direct/nested payload parity, close/resume/send/wait,
  parent messages, model exposure switches, capability restrictions, and host
  unavailability.

The existing subagent operations, completion, Fleet, reopen-approval, bash-gate and
Code Mode runtime suites remain the seams for descendant ownership, timer/listener
cleanup, serialized human dialogs, session allowance rechecks, shell background
lifetimes, replacement/reload/shutdown, and independent explicit wait/final delivery.
No second approval policy or spawn approval is introduced.

## Limits

Tree navigation retires live conversations using the existing manager close path;
explicit resume may recover manager-owned history under current permissions. Saved
trace data alone never reconstructs agents, cells, shells, store values or approvals.
Session replacement/fork/reload uses Pi's shutdown and replacement runtime, whereas
`session_tree` keeps the extension runtime and explicitly retires its old work.

No paid GPT-5.6/GPT-6 route smoke or interactive human approval is performed in this
unattended run. Native-host scenarios use controlled child sessions; the combined
live-provider and foreground/background child-model smoke remains #278's cutover
validation. No native source or contract definitions change.
