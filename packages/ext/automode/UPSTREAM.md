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

Only serialized active parent user fields are direct human instructions in the current
packet. Parent-generated subagent prompts, assistant prose, pending commands, and gate
hints are untrusted. Unlike upstream, Pi's current transcript does not independently
supply developer messages, AGENTS files, or request_user_input responses. User delegation
to a file or ticket is still recognized when evidenced in the packet. Validated
human-approved shell records describe prior approval, not blanket authorization.
Reviewer decisions are history, never human approval. The existing compacted Goal is
explicitly a generated summary: task-level context, not direct authorization for risky
specifics. Full retained instructions and tool-result evidence remain separate epic work.

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
