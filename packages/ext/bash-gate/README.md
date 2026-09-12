# Shared shell authorization

`registerBashGate()` returns a controller used by the ordinary `tool_call` hook and owned nested dispatchers. Capture its session handle while the Pi context is active:

```ts
const authorization = bashGate.captureSession(ctx);
// Later, after validating the actual nested arguments:
return authorization.authorize(
  { toolCallId: nestedCallId, toolName: "exec_command", command: args.cmd, signal: cellSignal },
  () => execTool.execute(nestedCallId, args, cellSignal),
);
```

Every launch needs a distinct call ID, including calls within the same cell. The callback runs synchronously after the final authorization/ownership check; do not defer process creation inside it without checking the executor's cancellation signal. A denial or cancellation rejects this call without invoking its callback or cancelling sibling calls. The runtime decides how an unhandled rejection affects its cell.

The handle snapshots Pi dependencies, accepts per-call cancellation, and becomes unusable on session replacement, shutdown/reload, or a tree-navigation attempt. Capture a fresh handle from an active lifecycle context after those transitions (including cancelled navigation). Never retain and later dereference the original `ctx`. Authorizations record the actual command and ID in custom session entries; nested callers must not manufacture transcript tool calls.

Classification remains launch-only (`bash.command` and `exec_command.cmd`); `write_stdin` is outside this policy. The dispatcher is responsible for validated arguments, tool availability, execution, and result handling. This interface does not activate Code Mode; dispatcher integration is tracked in #299.

Human prompts share a queue with parent subagent approvals. Reviews run independently; queued prompts recheck live session allowances. Dialogs receive abort signals, and cancellation settles callers even when a reviewer or UI does not cooperate. A non-cooperative displayed dialog retains its queue slot until it closes, preventing a competing dialog. Late choices cannot grant allowances or launch commands.

The existing Auto Mode escalation remains TUI/RPC `ui.select`; #286's host escalation interface has not landed on this branch. Headless review failures and denials continue to fail closed.

API grounding: installed Pi 0.85.1 `docs/extensions.md` sections `tool_call`, `ExtensionContext`, dialog options, and session lifecycle; `docs/rpc.md` extension UI protocol. Repository source corroboration used Pi 0.85.0, whose tool hook runner awaits handlers without an automatic cancellation race.
