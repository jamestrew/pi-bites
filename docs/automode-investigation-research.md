# Guardian investigation: local-source research

This is the historical pre-implementation research/proposal. The implemented contract,
including actual limits and supported deviations, is
[UPSTREAM.md](../packages/ext/automode/UPSTREAM.md). Probes below describe the former
implementation, not current evidence behavior.

## Scope

Source inspection of `/home/jt/projects/codex` at `cb6da58876` (the available checkout, not a required baseline). Codex citations below are relative to `../codex/codex-rs/`. No live model calls, runtime experiment, or policy-quality measurement. This supplements, rather than retroactively updates, the older pinned [`codex-auto-review-research.md`](codex-auto-review-research.md).

## Codex: actual investigation loop

**Codex does not give Guardian “three tool turns.”** It submits one ordinary agent turn per review attempt; that turn can make multiple sampling requests with tool calls before its final assessment. Tool calls set `needs_follow_up`; the ordinary turn loop samples again until no follow-up is needed. No Guardian-specific numeric tool-call/model-step cap was found on this path. The concrete review ceiling is a shared **90-second deadline**, not a small fixed turn count. [`ext/guardian-reviewer/src/execution.rs:36–56,66–160`; `core/src/stream_events_utils.rs:346–357`; `core/src/session/turn.rs:424–426,524–566,653–654`]

- **Three attempts** means retries for recoverable review failures, not an investigation allowance. Preparation and attempts share the same deadline. Parse/stale-authorization failures and selected transient provider/session failures can retry; completed allow/deny assessments, timeout, and cancellation do not. Provider request/stream retries are separately set to one. [`ext/guardian-reviewer/src/lib.rs:40–41`; `ext/guardian-reviewer/src/review.rs:75–105`; `ext/guardian-reviewer/src/retry.rs:20–65,94–137`; `ext/guardian-v2/src/sync_reviewer/reviewer_config.rs:12–17`]
- Timeout/cancellation interrupt the submitted turn and attempt to drain its terminal event for **five seconds**. Successfully drained sessions can be reused; otherwise they are discarded. Event matching rejects completions from other turn IDs. [`ext/guardian-reviewer/src/execution.rs:20,77–107,163–204`]
- A final assessment carries risk, authorization, outcome, and rationale. Policy denial is separate from parse/session failure, timeout, and cancellation; failures never silently become approval. An input-budget failure can return no reviewer decision when Guardian is not required. [`ext/guardian-reviewer/src/completion.rs:38–109,111–143`]

## Codex: installed tools and enforced restrictions

The current base allowlist is **`exec_command`, `write_stdin`, `view_image`, `exec`, `wait`**. The last two are native Code Mode orchestration; they do not imply unrestricted access to all normal coding-agent tools. The policy requires a **managed sandbox**, **unified exec**, and hides additional-permissions arguments. Actual model-visible tools vary with model/features: tests cover the three direct tools, preservation of Code Mode, and disabled shell capabilities. [`ext/guardian-reviewer/src/settings.rs:30–42`; `core/src/tools/spec_plan_tests.rs:602–723`]

The restriction is implemented, not merely a prompt:

- Parent permission profiles are intersected with read-only; writes become reads, deny entries remain denied, and the resulting network policy is restricted. The same ceiling is applied to every inherited environment. Approval policy is `Never`, so the reviewer cannot ask for escalated execution. [`protocol/src/models.rs:492–516`; `ext/guardian-reviewer/src/settings.rs:45–51,69–83`; `ext/guardian-v2/src/sync_reviewer/reviewer_config.rs:26–34`]
- Core tool registration returns early if the primary **or any selected environment** is not managed. Thus a prompt claiming read-only is insufficient to enable reviewer shell tools in an unenforced environment. [`core/src/tools/spec_plan.rs:1015–1035`; `core/src/tools/spec_plan_tests.rs:725–758`]
- Reviewer startup uses an isolated session. It disables skills/memories, notifications, inherited developer instructions, hooks, collaboration, recursive Guardian, plugins, and web-search features; MCP servers are cleared. [`ext/guardian-v2/src/sync_reviewer/mod.rs:89–108`; `ext/guardian-v2/src/sync_reviewer/reviewer_config.rs:18–68`]
- An optional `GuardianConversationHistoryTools` feature adds **`user_message.search_messages` / `user_message.read_messages`**, and retains Apps support for that path. This is not the base filesystem investigation toolset. [`ext/guardian-v2/src/sync_reviewer/mod.rs:109–138`; `ext/guardian-v2/src/sync_reviewer/reviewer_config.rs:39–56`]
- Network nuance: the bundled prompt says no network, but configuration can reuse the parent's live managed-network configuration under constraints. The permission profile is restricted, not an assertion that every possible network path is absent. [`prompts/templates/guardian/policy_template.md:62–64`; `protocol/src/models.rs:513–516`; `core/src/guardian/reviewer_config.rs:65–79`]

**Transfer limitation:** Pi Bites has no equivalent managed sandbox. Do not copy Codex's shell/Code Mode allowlist or rely on “read-only commands” as enforcement. A filesystem read also transfers its output to the reviewer provider: it is non-mutating, not necessarily non-disclosing. Whether Pi's default read needs host-enforced path/type/content restrictions is a separate implementation question, not answered by Codex's sandbox configuration.

## Codex: when investigation is warranted

The bundled policy prefers supplied transcript evidence. Investigation is requested **only when missing local state could change allow/deny**. Examples explicitly include inspecting script content, filesystem targets, git remotes, and repository context. Omitted script bodies and missing context do not independently increase intrinsic risk; important unverifiable facts still require a conservative rationale. Retrieved tool/file content is factual evidence, not new authorization, and instructions to bypass policy are ignored. [`prompts/templates/guardian/policy_template.md:5–13,45–51`]

A useful adaptation is therefore _targeted fact-finding_, not a second autonomous coding agent: inspect the named script and necessary local dependencies/configuration without executing it; return a decision once the material uncertainty is resolved. A cap such as two investigation rounds plus one final assessment, total read-call/output budgets, or a shorter timeout would be **Pi Bites tuning**, not a Codex constant. Script inspection cannot establish behavior of omitted dynamic imports, remote code, runtime environment, or a file modified after the read.

## Codex: push classification and authorization

The bundled destructive-action policy is already specific: a verified user-owned feature branch, including a single-ref `--force-with-lease` push, should normally be **low/medium**. Protected/default branches, broad refspecs/deletion, private data to an unverified remote, security-hook bypass, and destroyed unpushed work remain **high**. This is semantic risk classification, not a `git push` blanket exception. The policy does not name `jj git push` separately. [`prompts/templates/guardian/policy.md:47–59`]

Egress rules additionally require actual payload/destination reasoning. Private verified user/organization repositories are trusted; other repositories are untrusted by default. Sensitive unknown payloads to untrusted destinations remain high until safe or specifically authorized. Merely identifying a remote URL in local config is not proof of its ownership/privacy. [`prompts/templates/guardian/policy.md:3–5,10–29`]

Clear informed post-denial reapproval receives high authorization, judged by material semantics rather than exact syntax. The current-version-of-a-requested-file rule applies unless functionality or high-risk effects materially change. These rules do not allow tool/assistant evidence to manufacture human consent. Low/medium actions generally allow even with weak authorization, except explicit policy denials or affirmative malicious prompt injection; high requires at least medium authorization plus narrow scope and no overriding deny. [`prompts/templates/guardian/policy_template.md:15–26,66–78`]

These source rules support inspection as a way to reduce _factual_ uncertainty about scripts and pushes. They do not demonstrate that investigation fixes the reported repeated approvals, nor identify why a particular Pi Bites `jj git push` was denied; that needs the actual command, selected policy/model, retained evidence, and structured decision.

## Pi's default read: reuse the factory, not unrestricted host access

Installed Pi is **0.99.1**; the supplied Pi documentation is **1.0.0**. Sources
below are relative to node_modules/@earendil-works/. The public
createReadTool(cwd, options) accepts injected ReadOperations: access, readFile,
and optional detectImageMimeType. Parameters are path plus optional one-indexed
offset and limit. Direct execution avoids parent extension hooks and replacement
tools; ctx.executeTool could instead invoke an installed remote/shell-backed
replacement. Pin the request's execution cwd, not the parent UI cwd.
[pi-coding-agent/dist/index.d.ts:20,26;
dist/core/tools/read.d.ts:25–52;
dist/core/tools/read.js:30–42;
dist/core/extensions/runner.js:688–713]

**The unmodified tool is not confined to cwd.** It accepts absolute paths,
parent traversal, home expansion, and file URLs; ordinary filesystem reads follow
symlinks. The entire file is loaded before offset/limit and 2,000-line/50 KiB
output truncation. There is no regular-file admission check or input-byte limit.
The explorer confirmed harmless reads of /etc/hostname using both absolute and
traversal paths.
[pi-coding-agent/dist/utils/paths.js:59–86;
dist/core/tools/path-utils.js:35–46;
dist/core/tools/read.js:19–22,59–95,94–136]

Default read also returns supported images as attachments and decodes other binary
files as UTF-8. Installed image processing uses Photon WASM and workers, **not
shell subprocess converters**. Disabling resize alone does not make it text-only.
Use guarded text-only readFile operations and omit detectImageMimeType.
[pi-coding-agent/dist/core/tools/read.js:63–96;
dist/utils/image-process.js:21–43,72–80;
dist/utils/image-convert.js:3–15;
dist/utils/image-resize.js:11–14,67–84]

Abort rejects the outer execution and suppresses its result, but ReadOperations
receive no signal: already-running I/O is not automatically stopped. Capture the
review signal in guarded operations, bound actual input bytes, and validate the
opened regular file. A canonical-path check followed by a separate open has a
replacement/symlink race. These controls narrow a capability; they are not an OS
sandbox or proof that arbitrary source files contain no secrets.
[pi-coding-agent/dist/core/tools/read.js:43–58,150–158;
dist/core/tools/read.d.ts:25–36]

The existing streamSimple context accepts tools but does not execute them. A small
local loop can append assistant tool calls and matching toolResult messages.
Reuse exported validateToolArguments/validateToolCall. A full AgentSession would
add unnecessary resource discovery and session machinery; the low-level Agent loop
also has no built-in maxTurns/maxToolCalls setting.
[pi-coding-agent/dist/core/model-runtime.js:478–517;
pi-ai/dist/types.d.ts:532–535;
pi-ai/dist/index.d.ts:35;
pi-agent-core/dist/types.d.ts:225–279]

Pi also exports estimateTokens(message), a **chars/4 heuristic**, not a provider
tokenizer. It can replace the current byte-per-token approximation, but cannot
justify unmeasured context/cost increases.
[pi-coding-agent/dist/index.d.ts:6;
dist/core/compaction/compaction.js:197–251]

## Current Pi Bites: confirmed constraints

Closing commit 61c4ef235e aligns parent-message authorization trust with Codex.
It does **not** add investigation, increase history budgets, or add quoted-script
retry cases. The historical provenance conflict should not be called a confirmed
current cause.

- One streamSimple call, no tools; any stop reason other than stop is rejected.
  Merely declaring read would still reject toolUse. Usage and lifecycle validation
  precede committing only the final assistant response.
  [packages/ext/automode/index.ts:409–532](../packages/ext/automode/index.ts#L409)
- Parent, nested, and child paths reach the same controller with pinned execution
  context. The child broker preserves the child's cwd even though review runs in
  the parent. [packages/ext/bash-gate/index.ts:334–349,484–496](../packages/ext/bash-gate/index.ts#L334);
  [packages/ext/subagents/index.ts:351–376](../packages/ext/subagents/index.ts#L351)
- Tool evidence retains only 12 recent records and 12,000 characters per packet.
  **Inputs or text results above 1,200 serialized characters are omitted whole.**
  An earlier coding-agent script read need not expose its body to Guardian.
  [packages/ext/automode/tool-evidence.ts:3–26,102–126](../packages/ext/automode/tool-evidence.ts#L3)
- History remains capped at 96,000 serialized bytes; overflow rebuilds cold once.
  Child/concurrent borrowers cannot commit to the parent trunk. Investigation adds
  input and can worsen rollover/cost; it is not a cache-cost fix.
  [packages/ext/automode/history.ts:36–40,75–108,130–136](../packages/ext/automode/history.ts#L36)
- Original parent user messages are trusted; generated edits and child prompts are
  not. Human origin is still a role contract, not independently authenticated.
  [packages/ext/automode/index.ts:470–480](../packages/ext/automode/index.ts#L470);
  [UPSTREAM.md, Transcript-role trust](../packages/ext/automode/UPSTREAM.md#transcript-role-trust)

### Git/JJ push: what is known, and what is not

The policy already permits bounded verified user-owned feature-branch pushes as
low/medium, including one-ref force-with-lease. Low/medium defaults to allow even
with weak authorization **unless an explicit security deny applies**. Private
payloads sent to unverified destinations still trigger egress rules.
[packages/ext/automode/policy.md:49–78,103,126–139](../packages/ext/automode/policy.md#L49)

A no-model probe exercised the actual matcher:

| Command                          | Gate label / reason                                                               |
| -------------------------------- | --------------------------------------------------------------------------------- |
| git push origin feature/x        | git push                                                                          |
| jj git push --bookmark feature/x | unlisted: jj git push --bookmark feature/x; jj is not on the bash-gate allowlist  |
| python push_feature_source.py    | unlisted: python push_feature_source.py; python is not on the bash-gate allowlist |

This is review routing, **not deterministic denial**. Git push has an explicit
rule; JJ push and Python scripts fall through unlisted-command handling. The
labels/reasons reach the reviewer, although policy says they are not proof of risk.
[packages/ext/bash-gate/policy.ts:213–263,295–323,490–525](../packages/ext/bash-gate/policy.ts#L490);
[packages/ext/automode/index.ts:435,483–485](../packages/ext/automode/index.ts#L435)

There is **no red-capable model repro of the current push complaint**: no current
denied push was supplied with its command, structured decision, branch/destination
evidence, and preceding user instructions. Distinctions worth testing, not confirmed
diagnoses: missing remote/payload evidence activates egress rules; implicit JJ
bookmark selection leaves ref scope unclear; another compound-command action causes
the denial; or the model misapplies policy (possibly influenced by unlisted wording).
Do not globally allowlist pushes. Capture one sanitized real command/rationale and
replay the evidence with identical model/settings before changing policy. Local
Git config cannot prove server privacy, ownership, branch protection, or payload safety.

### Script inspection and reapproval are separate problems

Inspection can show that a dangerous-sounding filename has harmless behavior.
It does not itself fix misinterpreted human authorization. A quoted denial followed
by “allow it” or “this script is safe to run; stop blocking it” should bind to that
identified action and its already-stated effects. Clarify that reference resolution
without accepting assistant-asserted consent or materially changed effects.
Existing post-denial rules already support high authorization.
[packages/ext/automode/policy.md:22–29,133](../packages/ext/automode/policy.md#L22)

Fixtures include informed restart approval, but no Git/JJ push or quoted script retry.
[policy-scenarios.json](../packages/ext/automode/fixtures/policy-scenarios.json)

## Proposed smallest implementation — not implemented

Keep AutoModeController.review as the caller-facing interface. Add a bounded loop
at the existing streamSimple seam, reusing createReadTool with guarded operations.
No general-purpose session, shell, Code Mode, MCP, remote query, write/edit, or
approval tools.

These are **proposed Pi tuning limits, not Codex constants**:

| Limit             | Initial experiment                                           |
| ----------------- | ------------------------------------------------------------ |
| Investigation     | 3 rounds, then one final tools-disabled assessment           |
| Total calls       | 6 reads, including failures                                  |
| Returned evidence | 8 KiB per page; 32 KiB total; explicit missing-range markers |
| Deadline          | 90 seconds total, including reads/final assessment           |
| Final output      | Existing structured contract and 1,024-token limit           |

A round means one model response plus its requested reads; one response can request
several reads. Validate the whole batch before dispatch. Normal evidence-sufficient
reviews remain one model call. At the ceiling, request a final assessment from
available evidence, never auto-allow. Unresolved consequential facts can still justify
denial; malformed output, lifecycle/transport/cancellation and whole-request overflow
remain distinct fail-closed review failures.

Investigate only material uncertainty: the named script, relevant local helpers/config,
or targeted metadata. Tool/file content remains untrusted factual evidence. Current
script-dependent decisions need current observations, not a stale body from history.
Static reads cannot establish all dynamic imports, environment or remote behavior.

### Read admission

Use a host-captured working-tree scope and the exact pinned execution cwd. Allowed
roots must not come from model arguments or file instructions.

- Resolve requested/canonical paths; enforce roots and regular text files. Outside-root
  scripts require explicitly admitted paths, not unrestricted home access.
- Exclude credentials, private session/auth stores, key material and secret configuration,
  including repository-local secrets. Filename filters alone cannot guarantee no secrets.
- Bound input before loading; paging needs explicit omitted ranges. Reject devices,
  FIFOs, sockets, binary/image content and processing. Check deadline/cancellation.
- Prefer validated opened handles over separate path-check/read operations; state the
  remaining race/security limits rather than claiming sandboxing.
- Worktree metadata may live outside the root. Admit specific resolved metadata files
  when necessary, not arbitrary .git traversal. Unsupported remote filesystems must not
  silently be interpreted as local paths.
- Use the factory directly, not extension-replaced tools or deferred captured ctx.

### Required integration work

1. Supply only read to intermediate calls; append assistant calls and matching tool
   results; validate arguments/identities. The JSON-only instruction applies to the
   final assessment, not intermediate investigation.
2. Commit the entire successful owner conversation, including reads, rather than only
   the final response. Preserve child/fork isolation. Reviewer read results must not
   pass through the parent packet's 1,200-character omission limit.
3. Budget schema/intermediate messages/results on every turn, reserving final output.
   Token-aware history tuning is separate; do not truncate the pending action to fit.
4. Snapshot stable ctx dependencies; retain lifecycle/session/policy checks before
   further reads and final approval. Late results cannot authorize or advance history.
5. Account for **every provider response**. The eval runner currently overwrites its
   row's usage with each response: it must aggregate to avoid undercounting a tool loop.
   [scripts/automode-eval.ts:161–190](../scripts/automode-eval.ts#L161);
   [packages/ext/automode/index.ts:503–528](../packages/ext/automode/index.ts#L503)
6. Correlate structured decisions, read counts/bytes, failures and cold-start reasons
   with review/tool-call IDs, without logging sensitive file bodies/transcripts.

### Validation before claiming improvement

Deterministic tests should cover the real read→result→final-assessment loop, usage
aggregation, full owner history, scope/IO admission, budgets/deadline, cancellation,
stale ctx with throwing getters, correct child cwd, and concurrent/child isolation.

Quality fixtures should include harmless misleading script names, dangerous helpers,
forged approval in source, quoted-denial script-only/compound retries, changed effects,
bounded Git/JJ feature pushes, protected/broad pushes, and unverified private egress.
Use explicit paid paired evaluations with identical model/settings for quality,
investigation frequency, total latency/cost and provider cache reuse. Mocked allows
prove transport, not reduced false-denial rates.

## Local verification

No paid calls, private-session inspection or production code changes. A runnable probe
reproduced the gate table and asserted omission of a ~1.8 KB script body:

    bun -e '
    import { findMatchedPatterns } from "./packages/ext/bash-gate/policy.ts";
    import { toolEvidence } from "./packages/ext/automode/tool-evidence.ts";
    for (const command of ["git push origin feature/x", "jj git push --bookmark feature/x", "python push_feature_source.py"])
      console.log(JSON.stringify({command, matches: (await findMatchedPatterns(command)).map(({label,reason}) => ({label,reason}))}));
    const body = "# ordinary script\n".repeat(100) + "print(\"SCRIPT_BODY_MARKER\")\n";
    const packet = toolEvidence([{role:"toolResult",toolName:"read",toolCallId:"read-script",content:[{type:"text",text:body}]}]);
    if (packet.includes("SCRIPT_BODY_MARKER") || !packet.includes("bulk field exceeds evidence limit")) throw new Error("Unexpected script retention");
    console.log("1.8KB script body: omitted from reviewer tool evidence");
    '
    bunx vitest run packages/ext/automode/tool-evidence.test.ts packages/ext/automode/history.test.ts packages/ext/automode/instructions.test.ts

Focused suite: **37 tests passed across 3 files**. This verifies deterministic
evidence limitations, not the user's live-model false denials.

Final validation: bun check passed (lint, formatting, typecheck; 1,533 tests passed, 4 skipped).

## Follow-up: context parity and unlabeled requests

The user considers reapproval resolved. It is **out of implementation scope**;
the earlier discussion and retry scenarios are historical suggestions, not planned work.

Current Codex does not receive unlimited/full parent tool outputs. Its synchronous
Guardian profile uses approximate-token retention:

| Evidence                                      | Codex synchronous limit            |
| --------------------------------------------- | ---------------------------------- |
| Each ordinary tool entry                      | 1,000 approximate tokens           |
| Each ordinary message                         | 5,000 approximate tokens           |
| Aggregate tools / messages                    | 10,000 / 20,000 approximate tokens |
| Recent non-user entries                       | 40                                 |
| Required selected tools during final eviction | Newest 5                           |
| Reasoning / ordinary images                   | Excluded                           |

Oversized tool entries retain prefix and suffix with an explicit omitted-token marker.
The estimate is four UTF-8 bytes per token: 1,000 approximate tokens means 4,000
bytes, including the marker. The exact current action is separate and remains complete.
This differs materially from Pi's whole-field omission above 1,200 serialized
characters. Tool-native truncation and final whole-request admission are additional,
independent limits. Parity therefore means porting the synchronous selection/truncation
rules, not transmitting unbounded outputs.
[../codex/codex-rs/guardian-context/src/profile.rs:59–81,176–215,252–284;
guardian-context/src/transcript.rs:367–382;
guardian-context/src/truncation.rs:11–39;
guardian-context/src/enforcement.rs:107–155;
guardian-context/src/action.rs:11–21]

Codex's shell action has **no Pi-style labels array**. It can include an approval/retry
reason, but unmatched execpolicy fallback does not manufacture an “unlisted program”
reason. For matched Prompt prefix-policy rules only, derive_prompt_reason returns:

- “{command} requires approval: {user-configured-rule-justification}”, or
- “{command} requires approval by policy”.

Those reasons pass through approval context into the prompt, with retry reason preferred
and a 512-token cap; shell action justification is separately agent-supplied.
[../codex/codex-rs/core/src/exec_policy.rs:1022–1048;
core/src/tools/orchestrator.rs:202–215;
core/src/tools/approvals.rs:618–620;
core/src/guardian/prompt.rs:142–147;
guardian-context/src/action.rs:105–107]

Recommendation: remove Pi's labels and synthetic allowlist reasons from the reviewer
request, keeping them host-side for gate selection, UI and session allowances. Do not
replace them with another risk hint. If user-configured policy reasons are retained
later, identify their origin explicitly; “Codex has no approval reasons” would be false.

Coordinate three changes before claiming parity:

1. Adopt Codex synchronous evidence retention/selection and token-aware whole-request
   admission; the outer 40K-character transcript and 96KB history limits otherwise
   defeat an increase to the inner tool budget.
2. Remove classification hints at the shared reviewer interface, covering parent,
   nested and forwarded-child calls without changing which commands are gated.
3. Add the agreed guarded read loop; keep the three-round/six-read cap as an explicit
   Pi adaptation rather than pretending it is an upstream constant.

Code Mode adds an existing transport wrinkle: current reviewer evidence borrows
presentation traces already bounded to 8,192 characters per string with prefix-only
display truncation. A larger final packet cannot recover their missing tails.
Review evidence must use independently bounded factual observations before display
truncation, or this must remain a documented non-parity limitation.
[packages/ext/codex-adapter/code-mode/nested-traces.ts:31–90](../packages/ext/codex-adapter/code-mode/nested-traces.ts#L31);
[packages/ext/codex-adapter/code-mode/nested-tools.ts:124–164](../packages/ext/codex-adapter/code-mode/nested-tools.ts#L124)

No production implementation has started.
