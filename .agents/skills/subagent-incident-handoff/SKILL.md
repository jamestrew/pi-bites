---
name: subagent-incident-handoff
description: Capture a Pi subagent failure into a redacted temporary handoff for diagnosis in a separate session.
argument-hint: "[optional agent ID, time, or symptom]"
disable-model-invocation: true
---

# Subagent Incident Handoff

Capture evidence now; diagnose later. This invocation ends after writing a small
handoff under the OS temporary directory. Do not investigate causes, change code,
or retry the failed work unless the user separately asks.

## Capture

### 1. Snapshot the active session

Use one shell call to read only these variables; never dump the environment:

```bash
printf 'session_id=%s\nsession_file=%s\nprovider=%s\nmodel=%s\nreasoning=%s\n' \
  "$PI_SESSION_ID" "$PI_SESSION_FILE" "$PI_PROVIDER" "$PI_MODEL" "$PI_REASONING_LEVEL"
```

Also capture:

- current UTC time and working directory
- `pi --version`, when available
- the failing agent IDs, statuses, timestamps, provider/model/reasoning, and
  `failure_history`/`abort` metadata visible in Agent or WaitAgent results
- Agent launch count, concurrency, wait timeout, and elapsed durations when known

Do not inspect or summarize the current project's work, diff, or version-control
status merely to create this handoff. The user's active task may be unrelated.

Use the optional skill argument to narrow the incident. If it is absent, select
the most recent subagent failure visible in the current conversation. Do not ask
the user to repeat information already present.

If Pi session variables are unavailable, record that fact rather than guessing.
For an ephemeral session, record `session_file: unavailable (ephemeral)`.

### 2. Locate durable diagnostics

Resolve the diagnostics file without listing other Pi configuration files:

```bash
agent_dir=${PI_CODING_AGENT_DIR:-"$HOME/.pi/agent"}
diagnostics_file="$agent_dir/pi-bites/diagnostics/subagents.jsonl"
```

When it exists, find records matching the current `parentSessionId` and failing
agent IDs. Record only the matching line numbers, UTC time range, agent IDs, and
event names in the handoff. The diagnosing session can read those ranges later.

If the file or matching records do not exist, say so. This is useful evidence,
especially when Pi has not been reloaded since diagnostics were installed.

### 3. Write the handoff

Create a unique file with mode `0600` under `${TMPDIR:-/tmp}` named like:

```text
pi-subagent-incident-YYYYMMDDTHHMMSSZ.md
```

Use this structure:

```markdown
# Pi subagent incident

## Diagnosis request

One sentence describing the symptom to explain, without proposing a cause.

## Capture metadata

- captured_at_utc:
- parent_session_id:
- parent_session_file:
- working_directory:
- parent_provider_model:
- parent_reasoning:
- pi_version:

## Observed failure

- Exact chronological error and abort messages
- Terminal status and relevant failure_history/abort metadata

## Affected agents

| agent_id | type | provider/model | reasoning | status | timing |

## Timeline

| timestamp_utc | source | event | safe metadata |

## Evidence pointers

- diagnostics file, matching line ranges, and event time range
- session file reference, marked as sensitive

## Established facts

- Direct observations only

## Unknowns to resolve

- Questions the evidence does not yet answer

## Reproduction context

- Counts, concurrency, timeout, lifecycle actions, and usage/context sizes only

## Suggested skills

- `$skill:diagnosing-bugs` — build the feedback loop and test ranked hypotheses

## Start here in the diagnosis session

The first concrete command or artifact inspection, plus any reload/reproduction
needed to obtain missing telemetry.
```

Keep exact error messages and event order because a later abort must not replace
an earlier provider failure. Clearly separate observed facts from unknowns; the
capture session is not the place to infer root cause.

## Safety boundaries

Session JSONL can contain the entire conversation. Reference it, but do not copy
or summarize its prompt/content fields. Likewise, omit:

- user prompts and assistant prose unrelated to the failure
- subagent task descriptions, prompt text, tool arguments, and tool output
- credentials, cookies, authorization values, and sensitive headers
- full environment dumps, `auth.json`, or settings files that may contain secrets
- full diagnostic or session JSONL records when line references suffice

Preserve provider request IDs, allowlisted rate-limit metadata, timings, usage,
error types/messages, and nested causes when available. Replace the home directory
with `~` in paths and redact token-like values or URL query strings found inside
error text. Do not weaken an error into a generic summary after redaction.

## Finish

Verify the file exists and has mode `0600`. Reply with only:

- the handoff path
- a one-line summary of what was captured or what evidence was unavailable
- this suggested next-session prompt:

```text
Invoke $skill:diagnosing-bugs and diagnose the subagent incident documented at <path>. Keep the current work separate from that investigation.
```
