# Shared shell authorization

`registerBashGate()` returns a controller used by the ordinary `tool_call` hook and owned nested dispatchers. Capture its session handle while the Pi context is active:

```ts
const authorization = bashGate.captureSession(ctx);
// Later, after validating the actual nested arguments:
const execution = pinExecLaunch(args, stableToolContext);
return authorization.authorize(
  {
    toolCallId: nestedCallId,
    toolName: "exec_command",
    command: args.cmd,
    execution,
    signal: cellSignal,
  },
  () => execTool.execute(nestedCallId, args, cellSignal),
);
```

Every launch needs a distinct call ID, including calls within the same cell. The callback runs synchronously after the final authorization/ownership check; do not defer process creation inside it without checking the executor's cancellation signal. A denial or cancellation rejects this call without invoking its callback or cancelling sibling calls. The runtime decides how an unhandled rejection affects its cell.

The handle snapshots Pi dependencies, accepts per-call cancellation, and becomes unusable on session replacement, shutdown/reload, or a tree-navigation attempt. Capture a fresh handle from an active lifecycle context after those transitions (including cancelled navigation). Never retain and later dereference the original `ctx`. Authorizations record the actual command and ID in custom session entries; nested callers must not manufacture transcript tool calls.

Classification remains launch-only (`bash.command` and `exec_command.cmd`); `write_stdin` is outside this policy. The dispatcher is responsible for validated arguments, tool availability, execution, and result handling. This interface does not activate Code Mode; dispatcher integration is tracked in #299.

Human prompts share a queue with parent subagent approvals. Reviews run independently; queued prompts recheck live session allowances. Dialogs receive abort signals, and cancellation settles callers even when a reviewer or UI does not cooperate. A non-cooperative displayed dialog retains its queue slot until it closes, preventing a competing dialog. Late choices cannot grant allowances or launch commands.

The existing Auto Mode escalation remains TUI/RPC `ui.select`; #286's host escalation interface has not landed on this branch. Headless review failures and denials continue to fail closed.

API grounding: installed Pi 0.85.1 `docs/extensions.md` sections `tool_call`, `ExtensionContext`, dialog options, and session lifecycle; `docs/rpc.md` extension UI protocol. Repository source corroboration used Pi 0.85.0, whose tool hook runner awaits handlers without an automatic cancellation race.

## Pending execution context

Every production gate path supplies `execution` alongside the exact, untrimmed command. Direct `exec_command` calls arrive after Pi's argument preparation and schema validation; nested calls arrive after the dispatcher's strict validation. `pinExecLaunch` resolves and pins launch fields in those validated arguments **before** waiting for approval. The executor consumes the same pinned fields, even if the session directory or on-disk shell settings change while approval waits. The parent broker forwards the child's projection unchanged; its own cwd is not a substitute.

The bounded projection is:

- `cwd`: absolute initial process working directory. Omitted/empty workdir uses the captured session directory; relative workdir resolves against it. Shell startup scripts or the command itself can subsequently change directories.
- `shell`: resolved executable, including configured default, whitespace trimming, and the adapter's fish-to-bash adaptation.
- `login`: defaults true; Bourne shells receive `-lc` or `-c`. It does not imply `-i`. Cmd and PowerShell use their fixed platform argument forms regardless of this flag.
- `tty`: defaults false; controls PTY allocation and interactive stdin.
- Stock `bash` supplies its initial `cwd` and optional `requestedTimeoutSeconds`. Its shell/prefix are host-owned rather than model-selectable adapter options. This projection does not claim to inspect custom host spawn hooks or sandbox execution. Existing approval-wait timeout compensation is unchanged.

`yield_time_ms` and `max_output_tokens` only control response waiting/output presentation, not the launched command, so they are excluded. Unknown extra input (including environment overrides) is not forwarded to the adapter's process manager. Host environment values are not copied into the review. No cell-wide approval, sandbox permissions, network controls, or reviewer investigation tools are introduced. Authorization IDs, human escalation, and version-1 authorization records retain their existing shape; execution context belongs to the pending review, not a reusable grant. Other trusted Pi extensions remain responsible for not rewriting an approved command in a later `tool_call` hook.

Upstream grounding: `/home/jt/projects/codex` was verified at research baseline `a62e98d18c6550e3bea152ed1b89d1e931dca961`. Synchronous Guardian's `core/src/tools/approvals.rs` projects resolved argv, cwd and tty into `core/src/guardian/approval_request.rs`. Pi intentionally retains exact shell text plus resolved shell/login fields instead of Codex argv, uses Pi settings and executor-specific directory semantics, and omits Codex permission/justification fields that Pi does not implement. Pi 0.87.1's extension `tool_call` contract permits in-place changes to prepared, validated input before execution; no deferred callback reads a captured extension context here.
