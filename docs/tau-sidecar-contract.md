# Tau sidecar contract

Tau discovers live Pi agents through sidecar status files written by the `tau` extension. Dashboard implementations should treat this document as the compatibility contract between Pi sessions and Tau readers.

## Dashboard workflow

Tau is the multi-agent dashboard for Pi sessions. Start it with the Pi package command exposed for the dashboard, such as `pi agents` or `pi tau` depending on the installed Pi command surface. In this repository, the dashboard binary is also available as `tau` and can be run during development with `bun run tau`.

The dashboard scans the sidecar directory, groups the discovered sessions, and refreshes while it is open. Selecting a session opens native Pi with that session's `sessionFile`; Tau pauses its dashboard refresh while the child Pi process owns the terminal. Native Pi remains the session UI. Tau is only the observer/launcher around those sessions.

## Directory layout and ownership

The extension writes one status file per Pi session:

```text
~/.pi/agents/
  sessions/
    <sessionId>/
      status.json
```

When Pi is configured with a custom agent directory, the extension derives the Tau agents directory as the sibling `agents` directory next to Pi's agent directory. For the default Pi agent directory, this is `~/.pi/agents`.

`status.json` is owned by the running Pi extension process. It is written atomically via a temporary file and rename. Tau and dashboard code may read `status.json`, but must not modify it.

## `status.json` schema

Current schema version: `1`.

Required fields:

- `schemaVersion`: number. Must be `1` for this contract.
- `sessionId`: string. Pi session identifier, also used as the sidecar directory name.
- `sessionFile`: string. Path to the Pi session JSONL file for this session.
- `cwd`: string. Working directory for the Pi session.
- `pid`: number. Process id of the Pi process that owns the sidecar.
- `startedAt`: number. Unix epoch milliseconds when sidecar publishing started.
- `heartbeatAt`: number. Unix epoch milliseconds of the latest liveness heartbeat.
- `lastEventAt`: number. Unix epoch milliseconds of the latest state/event update.
- `status`: string. One of the status values below.

Optional fields:

- `ppid`: parent process id.
- `tty`: terminal identifier, when known.
- `title`: human-readable session title. If Pi does not provide a native title, the Tau extension may generate one from the first non-extension user input and publish it here.
- `currentAction`: human-readable description of current work, such as a tool command.
- `currentTool`: current Pi tool name.
- `lastError`: latest error summary, when known.
- `model`: model identifier, when known.

Status values:

- `idle`: session is alive and waiting between agent turns.
- `working`: agent is actively processing or running a tool.
- `needs-input`: session is blocked waiting for user input.
- `needs-permission`: session is blocked on a permission prompt, such as the bash gate.
- `stopped`: session shut down cleanly. Readers should not treat this as stale.
- `stale`: reader-derived state for a session whose heartbeat or process liveness failed. The extension does not need to write this during normal operation.
- `failed`: session ended or entered a known failure state.

## Generated session titles

Tau uses `title` as the primary dashboard row label when present. The Tau extension generates a title once, from the first user-authored prompt before the first agent run, only when the sidecar does not already have a title. Generated titles are short (at most 50 characters), stable for the lifetime of the sidecar, and stored only in `status.json`'s optional `title` field.

The generation policy is intentionally cheap and best-effort: the extension uses the same default model policy as the Explore subagent (`explore.defaultModel`, falling back to `github-copilot/claude-haiku-4.5`) with a single-line title prompt that disables tools. If model invocation is unavailable, times out, returns an empty title, or otherwise fails, the extension falls back to a deterministic title derived from the first user input. Tests must inject/mock title generation and must not require live model calls.

## Heartbeat, stale detection, and shutdown

The extension refreshes `heartbeatAt` every 20 seconds while the session is live, and also updates `heartbeatAt` and `lastEventAt` when state changes. Readers should use `heartbeatAt` as the liveness signal, not `lastEventAt`.

Readers should allow scheduler delays, suspend/resume jitter, and slow filesystems before marking a session stale. The extension exports a reader recommendation of 60 seconds without a heartbeat. A dashboard may also check whether `pid` is still live; a dead process or expired heartbeat can be displayed as `stale` unless the recorded status is `stopped`.

On clean Pi shutdown, the extension clears current action/tool fields and writes a final `status: "stopped"` record with fresh `heartbeatAt` and `lastEventAt` timestamps.

## Off-limits files

Tau and dashboard code must not write to Pi session JSONL files, including the path named by `sessionFile`. Those files are Pi-owned append-only session history. Dashboards may read them for display or summaries only when they can do so safely without mutating them.

Tau and dashboard code must also avoid writing `status.json`; only the Pi extension process owns sidecar writes.

## Returning from Pi to Tau

The extension registers an `/agents` command inside Pi. Running `/agents` cooperatively shuts down the Pi session. If the session was launched from Tau or another waiting parent process, that shutdown returns control to the dashboard/parent instead of leaving the user stranded inside the child Pi session. If native Pi was launched directly from a shell with no waiting parent, `/agents` only exits that Pi process; there is no Tau dashboard to return to.

## Related issues

This MVP contract is part of the pi-tau fold-in tracked by [pi-bites #22](https://github.com/jamestrew/pi-bites/issues/22). Related extension-side and dashboard issues: [#28](https://github.com/jamestrew/pi-bites/issues/28), [#29](https://github.com/jamestrew/pi-bites/issues/29), [#30](https://github.com/jamestrew/pi-bites/issues/30), and [#40](https://github.com/jamestrew/pi-bites/issues/40).
