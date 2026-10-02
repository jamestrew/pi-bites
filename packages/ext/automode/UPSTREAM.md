# Synchronous Guardian contract

The policy and assessment parser derive from OpenAI Codex, Copyright 2025 OpenAI,
Apache-2.0; see [LICENSE.codex](LICENSE.codex). The original adoption (#327–#333)
used local checkout `a62e98d18c6550e3bea152ed1b89d1e931dca961`.
The retention/investigation follow-up researched the available `../codex` checkout
at `cb6da58876`, not a required pinned revision. Detailed citations and historical
observations: [investigation research](../../../docs/automode-investigation-research.md).

## Policy and assessment

`policy.md` combines the upstream security policy and policy template, adapted to
Pi's available evidence. The authorization policy and host gate routing are unchanged:
low/medium defaults to allow without an additional task-scope veto; explicit security
denies still apply; high needs at least medium authorization and narrow scope; critical
defaults to deny. Missing evidence is not itself increased intrinsic risk, but
consequential unverifiable facts require caution. No special push exception is added.

`parseAutoModeDecision` requires allow/deny, validates any supplied risk/authorization/
rationale, defaults omitted/null risk and authorization, and supplies a default
rationale. Outcome drives approval. Provider, parse, stale-context, cancellation,
timeout, invalid-tool, and input-budget failures are distinct from completed policy
denials and fail closed. The existing human Allow once override remains a separate
host decision, never reviewer approval.

Upstream sources (relative to `codex-rs/`): `core/assets/guardian/policy*.md`,
`ext/guardian-reviewer/src/{assessment,completion,retry}.rs`. Newer checkout policy
assets live under `prompts/templates/guardian/`. Pi has no recoverable-error retry
loop; the three investigation rounds below are **not** Codex's three retry attempts.

## Evidence and trust

Original parent user-role messages from the active branch establish authorization.
This is role trust, not independently authenticated human authorship: Pi does not
persist origin for extension `sendUserMessage()` prompts. Extensions inserting parent
user messages participate in this boundary. Pi does not independently supply developer
messages, AGENTS files, or request_user_input responses.

`reviewerEvidence` uses Pi's exported session projection over branch copies without
compaction cutoffs. Original user entries hidden by compaction remain available;
context edits still replace/remove their targets. Entry IDs and order identify the
available branch. Missing ancestry and branch summaries mark unavailable history,
not reconstructed authorization. Generated replacements and compacted Goal summaries
remain untrusted context. A whole original instruction fits within 900 approximate
tokens or becomes an explicit omission marker: never splice a permission grant around
a missing restriction. Selection anchors the first user and considers newest users.

Assistant prose, pending actions, files, tool calls/results, and child prompts are
untrusted factual evidence, never human permission. Only validated human-approved
shell records describe prior human decisions. Historical reviewer decisions never
approve a new action. Child context and investigation cannot promote into parent
history. Requests contain only the exact command, pinned execution context, tool
name/call ID: **no synthetic classification labels or generic allowlist reasons**.
Host classification remains for routing, UI, and session allowances.

## Retention and admission

Codex synchronous profile: `guardian-context/src/{profile,transcript,truncation,
enforcement,retained_instructions}.rs`. Whole-request sources:
`core/src/guardian/{input_budget,request_budget}.rs`.

- Four UTF-8 bytes per approximate token, not a provider tokenizer.
- Tool arguments, text results, and selected execution/change metadata are capped at
  1,000 tokens per field; assistant text at 5,000.
- Prefix/suffix retention includes an explicit `<truncated omitted_approx_tokens="…"/>`
  marker within the cap, without splitting UTF-8 characters. Reasoning and image
  blocks are excluded. Non-JSON evidence becomes an explicit omission.
- Separate 10,000-token tool and 20,000-token message transcript allowances; newest-first
  selection, 40 recent ordinary non-user records. Original instructions and manual
  approvals take priority. Selected message/tool observations retain conversation order.
- Whole-request admission may evict optional commentary before older tools. Selected
  original instructions/manual approvals and the newest five **selected** tool records
  are required. If required evidence cannot fit, fail rather than silently trim it.
- The exact pending action and execution context are never truncated. Admission
  includes policy, tools, all reusable history, parent/child context, request framing,
  1,024 output tokens, configured thinking allowance, and a 256-token margin.
  History overflow rebuilds cold once, then fails explicitly if still too large.
  The former 40K-character transcript and 96KB serialized-history ceilings are gone.

Tool observations preserve call identity, state, text, and selected diff/exit/session/
truncation facts. Calls and approvals are not execution proof; a tool return is not
process success. Missing cwd stays unknown. Nested exec uses pinned workdir, not the
parent UI cwd. JSON evidence escapes framing characters.

Code Mode retains an independent immutable review snapshot **before** display-only
prefix/structural truncation. Live same-cell evidence shares transcript admission;
persisted results carry `details.reviewEvidence`. Older results fall back to
`details.traces`, whose missing tails cannot be recovered. Both snapshots share
trace eviction/clear lifecycle; display details do not restore live runtime state.

## Bounded investigation: Pi adaptation

Codex can investigate through managed read-only execution. Pi has no equivalent
sandbox, so Guardian gets only a guarded native `createReadTool` capability, invoked
directly, not extension replacements or `ctx.executeTool`. No shell, write/edit,
Code Mode, MCP, remote query, image rendering, or general agent capability is exposed.

Relative paths resolve from the **exact request execution cwd**, including children;
allowed paths are constrained to the owning session's host-captured workspace,
not expanded by a model-supplied workdir. Requested/canonical paths must remain
contained. Known credential filenames/private directories, non-regular files,
binary content, and inputs over 256 KiB are rejected. Opened-handle identity,
containment rechecks, bounded physical reads, and abort checks guard I/O. These are
application checks, **not an OS sandbox**, a complete secret detector, or protection
against every hostile concurrent filesystem change. Source files can contain secrets;
a read transfers permitted text to the configured reviewer provider.

One shared 90-second deadline covers at most three tool rounds, six reads (including
failures), then a final tools-disabled assessment. Read text is capped at 8 KiB per
result and 32 KiB total, including the factual-evidence label. Validate an entire
batch before invoking capabilities. Unknown tools, duplicate IDs, invalid ranges,
calls in final responses, or calls after exhaustion fail closed. Denied/missing reads
are error observations, not proof of safety; a subsequent policy assessment may still
decide an action using the available evidence.

## Lifecycle, isolation, and accounting

Only an idle parent review owns the history trunk. Concurrent/forwarded reviews may
borrow a compatible committed prefix but cannot promote. Failed/cancelled reviews
do not commit partial conversations or evict a good prefix. Successful commits retain
the complete assistant/tool-result chain plus final assessment. Provider payloads are
immutable snapshots; incremental reviews append rather than rewrite the prefix.

Session/branch/fork/compaction/reload and relevant model changes invalidate history.
Policy/session/branch freshness is checked between investigation steps and before
authorization; new parent instructions invalidate an in-flight assessment. Stable
dependencies are captured while extension ctx is active; deferred work never
dereferences captured ctx getters.

Every returned provider response gets an `automode_usage` record, including a late
response from a provider ignoring abort. Late responses cannot read again, authorize,
or commit. Native Pi read rejects promptly on abort, but its injected underlying I/O
may continue; guards check the snapshotted signal and always close opened handles.
The evaluation runner sums every investigation response and retains individual
diagnostics; cache-hit frequency counts provider responses, not review attempts.

Tests exercise transport and lifecycle at the provider/gate seams, not live model
quality or measured cache savings. [Evaluation](../../../docs/automode-evaluation.md)
documents the explicit paid runner and historical pilot limitations.
