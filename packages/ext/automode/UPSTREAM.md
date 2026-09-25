# Synchronous Guardian contract

Issue #327 adopts policy and structured assessments, not the rest of epic #326.
The local Codex checkout at `/home/jt/projects/codex` (the main Pi Bites checkout's
`../codex`) was verified with `git rev-parse HEAD` at
`a62e98d18c6550e3bea152ed1b89d1e931dca961`. All upstream paths below are relative
to `codex-rs/` at that revision.

## Sources and attribution

- `core/assets/guardian/policy_template.md`: evidence, authorization, risk, environment, outcome.
- `core/assets/guardian/policy.md`: the entire default security policy, including egress,
  credential probing, persistent security weakening, destructive actions, and low-risk exceptions.
- `ext/guardian-reviewer/src/assessment.rs` and `assessment_tests.rs`: schema, parser,
  outcome-only responses, defaults, and prose-wrapper recovery.
- `ext/guardian-reviewer/src/completion.rs`: outcome drives approval; rationale drives
  denial; failures are distinct from completed policy assessments.
- `ext/guardian-reviewer/src/retry.rs` and `lib.rs`: upstream retries recoverable session
  and parse failures, at most three attempts within a 90-second deadline.

`policy.md` combines the two upstream policy assets, with the Pi adaptations below.
The parser in `index.ts` ports the assessment contract. These portions derive from
OpenAI Codex, Copyright 2025 OpenAI, licensed under Apache-2.0; see
[LICENSE.codex](LICENSE.codex). They have been modified for Pi Bites.

## Policy and capability adaptations

The policy retains the full security rules and exceptions, not only the thresholds.
Low/medium risk defaults to allow regardless of authorization. There is **no additional
task-scope veto**. Explicit security denies still apply. Malicious prompt injection
requires affirmative evidence of both an unrelated action and an instruction from
untrusted evidence. High risk requires at least medium authorization, narrow scope,
and no absolute deny. Critical defaults to deny. Missing evidence does not itself
increase intrinsic risk, but consequential unverifiable facts warrant caution.

Pi has no Codex sandbox or network allowlist; this reviewer has **no tools**. The
investigation/environment sections are replaced, and imperative inspection instructions
are adapted to supplied evidence. No command is executed by the reviewer. References
to checks in risk examples are evidence conditions, not claims of available tools.

Serialized active parent user fields retain user-role provenance, not verified human
authorship (see #331 below). Parent-generated subagent prompts, assistant prose, pending commands, and gate
hints are untrusted. Unlike upstream, Pi's current transcript does not independently
supply developer messages, AGENTS files, or request_user_input responses. User delegation
to a file or ticket is still recognized when evidenced in the packet. Validated
human-approved shell records describe prior approval, not blanket authorization.
Reviewer decisions are history, never human approval. The existing compacted Goal is
explicitly a generated summary: task-level context, not direct authorization for risky
specifics. Tool-result evidence is described below for #332.

Informed post-denial human approval can meet the high-risk authorization threshold;
it cannot make the reviewer approve an action that remains critical or absolutely denied.
The existing **human Allow once override** remains a separate host permission decision,
including for critical denials; it is not relabeled reviewer approval. This preserves
Pi's explicit human control rather than adding a new hard prohibition to the gate.

## Assessment and failures

`AutoModeDecision` always returns `risk_level`, `user_authorization`, `outcome`, and
`rationale`. As upstream does, the parser:

- requires `outcome` to be `allow` or `deny`;
- accepts omitted/null risk and authorization, defaulting risk to `low` for allow or
  `high` for deny, and authorization to `unknown`;
- defaults omitted/null/blank rationale to the upstream outcome-specific sentence;
- validates non-null enums and rationale types; ignores unknown fields;
- accepts JSON wrapped in prose/fences using first-open/last-close brace recovery;
- rejects non-JSON, missing/invalid outcomes, malformed JSON, and invalid field types.

The model derives the outcome using the whole policy. The host does not recompute a
threshold-only verdict from risk/authorization (that would discard policy exceptions
and custom policies). Like upstream, parsing does not cross-validate outcome against
risk. Pi asks for JSON through a provider-neutral prompt rather than Codex's provider
JSON-schema mechanism; validation remains mandatory at the application boundary.

Only successful `stop` responses are parsed. Provider errors, partial outputs, timeouts,
cancellation, and parse failures throw and follow the existing fail-closed path, not the
policy-denial escalation path. Unlike upstream's three-attempt retry layer, Pi retains
one application-level attempt with its existing 90-second provider timeout. No extra
retry, adaptive approval, cache, sandbox, or investigation loop is introduced.

Parent, nested, and forwarded subagent decisions continue through the shared approval
paths. Outcome and rationale control allow/deny and human escalation. Session ownership,
cancellation races, and snapshotting of ephemeral ctx dependencies are unchanged.
Usage is recorded before stop-reason checking/parsing, including failed responses when
usage exists; thrown requests with no response have no invented usage. Usage storage
failure cannot change the approval decision. The usage schema is unchanged.

## Configuration and evaluation

`autoMode.model`, `autoMode.thinking`, and `autoMode.policy` remain supported. A custom
policy still replaces the bundled policy completely; the JSON output contract is
appended in either case. No configuration migration is required. Existing outcome-only
custom replies receive upstream-compatible defaults, while invalid typed fields now
fail closed instead of being silently discarded.

`fixtures/policy-scenarios.json` contains authored evaluation cases with messages, exact
commands, and expected assessments. It covers weak-authorization low/medium actions,
high-risk authorization, critical destruction, benign and malicious untrusted evidence,
explicit security denial, informed approval, forged approval, and sensitive egress.
`index.test.ts` replays those responses through the real reviewer/parser and parent and
nested gates. Forwarded approval, interactive override, concurrent decisions, stale ctx,
late cancellation, and usage paths also have regression coverage in existing suites.

Run `bunx vitest run packages/ext/automode/index.test.ts` for the fixture checks and
`bun check` for all validations. **Mocked assessments prove wiring, not live policy
quality.** For live evaluation, supply each case's messages and command to the reviewer
with the bundled policy, without supplying `assessment`; compare outcome/risk/authorization
and inspect rationale manually. Record provider/model/thinking, failures, latency, and
usage separately. No live model quality, cache improvement, or cost claim is made here;
those require the real-model evaluation work in #326.

## Sequential conversation reuse (#329)

The local Codex checkout was re-verified at
`a62e98d18c6550e3bea152ed1b89d1e931dca961` for this change. References:
`core/src/guardian/review_session.rs`, `review_session_context.rs`,
`review_session_factory.rs`, and `input_budget.rs`. Pi adopts the idle sequential
conversation, incremental evidence, fresh synchronous assessment, and whole-request
budget. It does not adopt Guardian V2, investigation tools, or approval reuse.

`history.ts` retains a bounded committed conversation. A compatible review appends
new parent context and authorization records plus the exact pending action after the
previous assessment. Earlier messages are not rebuilt or reordered. Later validated
records supersede earlier records for the same action; reviewer outcomes never become
human authorization. Only successfully parsed, noncancelled assessments commit.

Pi passes a reviewer-only random `sessionId` through `ModelRegistry.streamSimple`.
It remains stable across compatible sequential reviews, separate from the coding
agent's session identity. This is provider cache/routing affinity, not a guarantee of
cache hits; fresh requests can also hit provider caches. Provider defaults for cache
retention remain unchanged. No provider-specific transport is introduced.

Intentional deviations from Codex:

- Compatible overlapping and forwarded reviews fork the committed parent prefix;
  only the idle parent trunk owner can commit, as detailed below for #330.
- The input ceiling is 96,000 serialized UTF-8 bytes, further constrained by the
  model context window minus 1,024 response tokens and the selected thinking
  budget (1,024 minimal / 2,048 low / 8,192 medium / 16,384 high or above).
  Pi expands budget-based Anthropic/Bedrock output beyond `maxTokens`; these
  existing defaults are explicitly passed as `thinkingBudgets` and reserved even
  for providers that do not expand output. The estimate charges one token
  per UTF-8 byte plus 256 tokens per message/system framing, conservatively rather
  than using Codex's provider-aware wire estimator and 256-token safety margin.
  Budget includes policy, all history, evidence, exact action, and output reserve.
  At the ceiling, history rebuilds once from the current bounded evidence with a
  new cache identity. If that request still cannot fit, review fails closed without
  truncating the pending command, execution context, or forwarded context to fit.
- History is memory-only, with fixed-size hashes/counts for context and branch
  cursors. Model/provider/options, installed policy, execution context, session,
  branch navigation, context rewrites, compaction, and reload invalidate reuse.
  Ordinary append-only growth does not. Navigation attempts reset conservatively
  even if later cancelled. Late completions cannot commit or return approval after
  invalidation; deferred work uses snapshotted dependencies, never captured ctx.
- Tool-result evidence is described below for #332; #331 updates retained
  instruction selection and provenance. No extra retry
  or model call is added. Usage recording retains input, cache reads/writes, output,
  reasoning where supplied, actual served model, and cost, including failed responses.

### Comparable pre-replacement workload

The one-shot implementation remains reproducible at Pi Bites commit
`219d013e` (the parent of this change), using the same bundled policy, model,
thinking level, and `fixtures/policy-scenarios.json`. For a sequential cache/cost
comparison, use a fresh session with user instruction “Remove only generated build
files”, then review `rm build-a.txt`, append user instruction “Keep protected.txt”,
review `rm build-b.txt`, and review `rm protected.txt`, all in the same cwd. Run once
cold and repeat warm for each implementation with the same provider/model/thinking.
Record each invocation, assessment, latency, and the existing `automode.jsonl` usage
rows; compare uncached input, cache reads/writes, output/reasoning, and cost separately.
Also repeat after compaction and with two overlapping reviews to expose resets and
concurrent fork costs. Do not infer provider cache hits from mock payload tests.

The issue's earlier 100-record observational baseline reports 42 reviews with cache
reads, 172,544 cached versus 268,685 uncached input tokens (39.1% cached), and 55/97
repeat-session/model reviews with no reads. These are historical observations, not
measurements of this patch or proof that omission of `sessionId` caused cache misses.
No live-model cache, policy-quality, or cost improvement is claimed by this change.

## Concurrent review forks (#330)

The local Codex checkout is re-verified at
`a62e98d18c6550e3bea152ed1b89d1e931dca961`. In addition to the sources above,
`ext/guardian-reviewer/src/pool.rs` forks a busy compatible trunk from its last
committed snapshot, commits only reusable trunk completions before releasing
ownership, and never promotes ephemeral forks. `core/src/guardian/tests.rs`
checks shared cache identity, transcript deltas, and exclusion of in-flight actions.

Pi follows that owner-only commit rule: the first parent review while the trunk is
idle owns its next commit. Compatible concurrent reviews independently clone the
committed messages and append only their own exact action, new parent evidence,
and labeled request-local subagent evidence. They reuse the prefix's reviewer
`sessionId` without waiting for other model reviews. Human-dialog serialization
remains unchanged. A cold trunk has no committed prefix to borrow; cold forks use
independent identities until a parent assessment successfully commits.

Only a successfully parsed, noncancelled owner assessment may advance history,
including a policy denial. This is stricter than Codex's pool-level `Completed`
rule. Forks never commit or promote, even if the owner fails, or if they finish
after a newer owner. Thus out-of-order completions cannot overwrite newer history.
The evidence cursors advance only with the owning snapshot: evidence observed by
a fork alone is sent again on the next trunk review, not skipped or merged from
another pending action. Failed/cancelled assessments leave the prefix intact.

Forwarded subagent reviews are deliberately read-only borrowers of compatible
**parent** history. No stable child-session identity is needed because child prose
and actions never enter the trunk or another child's request. Their current packet
labels child prose as untrusted agent-generated context, never direct human
authorization. Session/model/policy/branch compatibility and execution scope still
bound reuse; incompatible child requests stay cold without evicting parent history.
Lifecycle resets invalidate both owners and forks, using snapshotted dependencies
rather than deferred access to ephemeral Pi `ctx` getters.

Each fork independently applies the same whole-request and output budgets. If the
prefix plus current action cannot fit, that request rebuilds cold with a new cache
identity; rebuilds and failed requests do not evict the shared prefix. Retained
history is still bounded to one committed conversation, with no queue of completed
forks. Per-request cancellation and usage recording remain independent. This does
not cap the number of concurrent callers or promise provider cache hits.

`history.test.ts` and `forks.test.ts` exercise both completion orders, late forks
behind newer commits, incremental evidence, parent/child isolation, cold and
incompatible forks, budget rebuilds, allow/deny/error/cancellation, independent
command launch and usage, and lifecycle invalidation with throwing stale-ctx
getters. These mocked integrations demonstrate request isolation and launch safety,
not live-model decision quality or measured cache savings.

## Retained instruction evidence (#331)

The local Codex checkout at `/home/jt/projects/codex` is verified at
`a62e98d18c6550e3bea152ed1b89d1e931dca961`. Sources:
`guardian-context/src/retained_instructions.rs`, `retention.rs`, and
`authorization.rs`. Synchronous Guardian retains whole genuine-user records with
ordered provenance and explicit incompleteness; its per-item approximate budget is
900 tokens and its selector anchors the first user, then considers newest users.

Pi reconstructs available original user-role messages from **only the active branch**
on every review, including messages hidden by compaction. It reuses Pi's exported
`buildSessionProjection` over branch copies without compaction cutoffs, reconnecting
parent links so removed compaction entries cannot break traversal. Context edits still
replace or omit their targets, even when those targets are compacted away. Replacements
are labeled generated context, never original wording; removals leave an omission
marker. Rebuilding reviewer history, reopening the persisted session, and extension
reload use this same source, not a second permission ledger or model-produced summary.
Branch/session replacement cannot recover entries from an abandoned branch/session.

### Pi provenance constraint

Pi 0.87.1 persists user messages without their `input.source`. Both human prompts and
`sendUserMessage()` extension prompts become user-role messages. Pi also has no public
correlation ID between `input` events and accepted/persisted messages: transforms,
handled inputs, queue cancellation, and steering/follow-up order prevent reliable
pairing. Appending a trusted input marker before acceptance is unsafe: tree navigation
to a user message selects its parent, which would leave that marker active after the
user message is abandoned. This change deliberately does not add such markers.

Each retained record therefore includes its source entry ID, branch-relative order,
and whether it was context-edited. The packet explicitly identifies original user-role
wording as **origin unknown**, not authenticated direct-human permission. This is an
intentional conservative adaptation from Codex's genuine-root-user assumption, including
on reload. Unknown-origin text cannot independently establish human authorization;
validated historical human shell approvals retain their existing separate meaning.
Generated Goal summaries remain labeled task context, never direct authorization.
Child prompts remain parent-assistant-generated evidence in a separate request-local
section. Full direct-human authorship requires an upstream persisted input-origin and
correlation contract; text matching or generated summaries cannot supply it.

### Bounds and omissions

The evidence transcript keeps its 40,000-character ceiling and 8,000-character serialized
entry ceiling. Unlike upstream's first-user anchor, Pi selects the latest original
user-role instruction first, then earlier instructions newest-first, then shell history,
then assistant/edited context. Selected records are emitted in original order. Shell
history never displaces a fitting intermediate original instruction. Whole original
instructions are retained or omitted: oversized text becomes a source/order/length
marker, not a head/tail splice that could hide a restriction while retaining a grant.
Budget omissions explicitly warn that missing instructions may restrict older grants.
Missing branch ancestry, missing compaction boundaries, and branch summaries indicate
unavailable original history, never a license to reconstruct trusted instructions.

The existing whole-request UTF-8 budget still includes policy, history, evidence, and
output reserve. If a rebuilt request cannot fit, it fails explicitly; the exact action
and execution context are never truncated. No extra low/medium-risk scope veto, live
model call, adaptive approval, sandbox, or investigation tool is introduced.

`instructions.test.ts` exercises provider-visible packets with real SessionManagers:
pre/post-compaction ordering, intermediate restrictions under shell-history pressure,
latest changes, whole oversized omissions, reviewer-budget rebuilds, malicious summaries,
context edits, unavailable history, branch/session isolation, persisted reload, and
forwarded subagent provenance. These fixtures prove evidence transport, not live-model
authorization quality or measured provider cache savings.

## Bounded tool evidence (#332)

The local `/home/jt/projects/codex` checkout is re-verified at
`a62e98d18c6550e3bea152ed1b89d1e931dca961`. References:
`guardian-context/src/transcript.rs`, `profile.rs`, and
`core/src/guardian/prompt.rs` and `request_budget.rs`. Synchronous Guardian keeps
calls/results with call identity, separate tool retention limits, no reasoning or
images by default, and an assembled-request budget. Pi adapts this to its persisted
`toolResult` messages and Code Mode `details.traces`; it adds no investigation tools.

The shared parent/child transcript builder supplies calls (including file mutation
arguments), text results, and a small allowlist of file-change/exit/session/truncation
metadata. Calls and authorization records never prove execution. Tool return is not
process success: exit codes, running session IDs, and errors must be considered;
errors can precede execution or leave partial effects. Missing calls, directories,
outputs, and prior observations remain unknown, not inferred successful operations.
Nested traces retain their outer-call identity and state, never a parent-human role.
For nested exec, pinned `input.workdir` is the effective directory; other traces
carry their captured directory. Direct calls preserve supplied arguments and results,
but do not invent a historical cwd when none was recorded. The exact current action
continues to carry its separately pinned execution context.

Deterministic Pi limits (intentional adaptations from upstream token estimates):

- Each transcript's tool packet selects the newest 12 records, walking backwards
  until its 12,000-character allowance is exhausted, then emits chronological order.
  It reserves 400 characters for labels/omissions. Original instructions still take
  priority under the shared 40,000-character transcript ceiling.
- Each input, combined text-content field, and selected details object is retained
  whole up to 1,200 serialized characters. Larger fields are omitted whole with their
  original length, not spliced into a misleading script or diff. A record exceeding
  4,000 serialized characters becomes an explicit whole-record omission marker.
  Images/non-text blocks are omitted with a marker. Reasoning is never collected.
- Count/size selection leaves an explicit omitted-record count. Code Mode traces
  are already lossy presentation snapshots (128 calls, structural limits, 8,192-char
  strings); upstream display truncation markers remain evidence of missing data.
  Trace eviction before a packet cannot be reconstructed and absence is not success.
- Live same-cell traces travel as snapshotted request-local evidence through the
  nested authorization session and, for children, the parent approval broker. This
  includes prior results before the outer `exec`/`wait` observation is persisted.
  Live evidence gets its own identically bounded packet. Persisted snapshots use
  ordinary incremental parent history; forwarded child evidence never commits there.
- All tool fields are JSON data with angle brackets/ampersands escaped, labeled
  untrusted factual evidence, never human authorization. Embedded role labels,
  approval claims, or closing tags cannot create a transcript record or close its
  framing. The reviewer has no tools, sandbox, or permission-decision cache.

The existing **whole-request** budget charges policy, retained instructions, all
reusable history, both parent and child tool packets, live traces, exact current
action, provider framing, and output/thinking allowance together. Packet limits do
not substitute for that check. Compatible additions append without rewriting the
committed prefix; immutable provider payloads cannot change with later traces.
History overflow rebuilds cold once; a still-oversized request fails explicitly,
without trimming the exact action or the selected evidence to force approval.

`tool-evidence.test.ts` exercises generated-file cleanup, failed commands, bounded
bulk output, injection-shaped text, nested persisted/live traces, forwarded child
packets, incremental immutable history, and whole-request failure at the actual
provider payload seam. Code Mode and fleet wiring tests exercise live nested and
forwarded transport with stale ctx. These are transport fixtures, not evidence of
live-model quality or measured provider cache savings.

## Replacement validation (#333)

The integrated reviewer is the only production path. The explicit real-model runner,
archived one-shot comparison, measured limitations, and removal audit are documented
in [automode evaluation](../../../docs/automode-evaluation.md). The local Codex checkout
remains at `a62e98d18c6550e3bea152ed1b89d1e931dca961`. Earlier per-increment
statements above describe what was measured at those increments, not the later pilot.
