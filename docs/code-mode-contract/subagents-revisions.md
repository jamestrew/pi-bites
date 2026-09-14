# V1 revision evidence

#305 selects `25af12f7e61572b0bc18ddb1008be543b91519b0` (`rust-v0.145.0`), the
existing Code Mode model-facing and host pin. Sources are Git objects in
`~/projects/codex`, not that checkout's current working files. No host upgrade,
Codex backend, or V2 migration is required. The normative supported target is
[CODEX_V1.md](../../packages/ext/subagents/CODEX_V1.md).

## Comparison

| Area                         | Selected `25af12f7`                                                                                                                                                     | Old baseline `ddf8a67ab09cd76b8adc0969f11ee1271179aba7` / inspected `a62e98d18c6550e3bea152ed1b89d1e931dca961`                                                             |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Operations and native naming | Five V1 operations in `multi_agent_v1`; JavaScript conversion uses `__`                                                                                                 | Same five-operation family and conversion; V2 is distinct, not a renaming of V1                                                                                            |
| Spawn arguments              | Includes `service_tier` and Responses `items`                                                                                                                           | Both later inspected revisions omit `service_tier`; plain-text Pi projection omits both unsupported inputs explicitly                                                      |
| Spawn model-override prose   | Allows setting `model` when explicitly requested **or there is a clear task-specific reason**; spawning itself still requires user/applicable-instruction authorization | Earlier local contract copied the narrower old-pin model-override wording; do not retain that wording while claiming the selected pin                                      |
| History/roles                | Full-history fork rejects explicit role; ordinary spawn applies role after model overrides; default role is `default`                                                   | Same V1 distinction; role-loader location/config plumbing differs                                                                                                          |
| Role/config inheritance      | `agent/role.rs` + `config/agent_roles.rs`; live turn model/provider/reasoning/developer instructions/cwd/approval policy/permission profile seed child config           | Other pins use separate agent-roles crate; catalog role/mode hints and permission snapshot plumbing differ. None justifies Pi's explorer-only read-only boundary           |
| Resume capacity              | `resume_single_agent_from_rollout` reserves before reopening the session, commits after load; failed reopening drops the reservation                                    | Same reservation timing at all three pins, not a new requirement caused by the rebaseline                                                                                  |
| Close and completion         | Close snapshots previous status, closes known subtree; completed open agents retain concurrency                                                                         | Existing V1 target stays intact; Pi's unusable ordinary close/resume is not a supported deviation                                                                          |
| V1 exposure                  | `Deferred` with search, otherwise `Direct`                                                                                                                              | Same V1 choice; V2 may use `DirectModelOnly` through its separate configuration                                                                                            |
| Internal changes             | `CodexErr`, exact requested model multi-agent-version predicate, V2 residency flow, simplified mode/hint sourcing                                                       | Other pins use `CodexErrorDetails`, broader non-disabled model predicate and catalog hints; do not import these internal changes or V2 task hierarchy into the V1 baseline |

The declaration extractor records exact supported factory text instead of maintaining
a hand-edited second prose copy. Broader collaboration/model templates and dynamic
catalog hints remain separate from those definitions. Historical research links pin
the revision actually inspected; they do not override this selected baseline.

## Behavioral source ledger

All paths below are relative to `codex-rs/` at the selected revision. These facts
specify parity for follow-up implementation, not a claim that every local path is
already aligned.

- `core/src/tools/handlers/multi_agents_common.rs`: `parse_collab_input` rejects blank
  text with `Empty message can't be sent to an agent`. Native message/items exclusivity
  errors are `Provide either message or items, but not both`, `Provide one of: message
or items`, and `Items can't be empty`; those structured-input branches are excluded
  by Pi's required plain-text projection. `collab_agent_error` maps missing IDs to
  `agent with id {id} not found`, dead agents to `agent with id {agent_id} is closed`,
  unsupported manager operations to `collab manager unavailable`, and other errors to
  `collab tool failed: {err}`.
- The same file's `build_agent_spawn_config` uses live turn configuration, not a fresh
  unrelated default. `build_agent_resume_config` clears base instructions before
  reconstructing the resumed configuration. Model resolution honors supported explicit
  override/default settings; unknown model errors report ``Unknown model `{model}` for
spawn_agent. Available models: ...`` (picker list capped at five). Service-tier
  validation exists at this pin but is intentionally not an advertised Pi control.
- `core/src/agent/role.rs::apply_role_to_config` defaults an omitted type to `default`;
  unknown roles report `unknown agent_type '{role_name}'`; invalid/unavailable role
  configuration reports `agent type is currently not available`. Role configuration
  preserves model/provider/service-tier/reasoning when those keys are absent. It is
  guidance/configuration layered over inherited permissions, not a separate explorer
  read-only sandbox.
- `core/src/tools/handlers/multi_agents/spawn.rs::handle_spawn_agent` validates input,
  trimmed role, model/effort, and depth before child creation. Depth failure is
  `Agent depth limit reached. Solve the task yourself.` Full-history fork rejects
  explicit `agent_type` with `Full-history forked agents inherit the parent agent type;
omit agent_type, or spawn without a full-history fork.` and skips applying a replacement role. Preserve full history,
  not just the latest prompt.
- `core/src/tools/handlers/multi_agents/send_input.rs` parses the target, ensures a
  known agent is loaded, optionally interrupts, then submits input. Interruption and
  submission are distinct effects; failure between them cannot restore the prior turn.
- `core/src/tools/handlers/multi_agents.rs::parse_agent_id_targets` rejects an empty
  list with `agent ids must be non-empty`; `parse_agent_id_target` rejects malformed
  IDs with `invalid agent id {target}: {err:?}`.
- `core/src/tools/handlers/multi_agents/wait.rs::Handler::handle_call` parses selected
  IDs and subscribes only to those statuses. Default is 30,000 ms, positive timeouts
  clamp to 10,000–3,600,000 ms; nonpositive input errors with `timeout_ms must be greater
than zero`. A syntactically valid missing ID yields final `not_found`, not a generic
  missing-target error. Already-final selected statuses return together; otherwise the
  first final status releases the wait, including other immediately-ready results.
  Timeout yields an empty map. Completion notification is independent of this wait.
- `core/src/tools/handlers/multi_agents/close_agent.rs::handle_close_agent` subscribes
  for previous status, falls back to `get_status` when a known closed agent has no
  live thread, and calls agent-control close. Unknown IDs fail. Repeated close of a
  known closed agent yields `shutdown`.
- `core/src/tools/handlers/multi_agents/resume_agent.rs` parses a thread ID (malformed
  IDs report `invalid agent id {raw}: {err:?}`), checks depth, and attempts stored-thread
  resume for `not_found`. `core/src/agent/control/spawn.rs::resume_single_agent_from_rollout`
  reads stored identity/history, reserves a slot (selected lines 854 onward), reopens
  with history, and commits the reservation (line 894). Earlier source positions were
  1205/1247 at `ddf8a67` and 1243/1285 at `a62e98`. Reading stored data is not the
  reopening commit. Reserve before the live session exists or a new turn starts.
- `core/src/agent/control/spawn.rs` creates children with parent thread/turn identity,
  reserves spawn capacity, commits after creation, and subsequently submits initial
  input. These separate effects do not establish an atomic cancellation rollback.
  `core/src/tools/parallel.rs` cancels unfinished handlers, not session-owned children
  that have already committed. Pi must specify lost-result discoverability and owner
  invalidation explicitly rather than claim stronger upstream transactional semantics.
- `core/src/tools/spec_plan.rs::add_collaboration_tools` chooses V1 deferred exposure only when
  `search_tool_enabled(turn)`; otherwise it is direct/eager. V2's separate
  `non_code_mode_only` setting can produce `DirectModelOnly`. Local unconditional V1
  deferral uses native `ALL_TOOLS`, not Responses tool search.
- `tools/src/code_mode.rs` converts namespace/tool names and native JSON output
  schemas into declarations; `core/src/tools/handlers/multi_agents_common.rs` and
  per-operation result implementations use `serde_json::to_value` for nested output.
  `core/src/session/multi_agents.rs` at this pin primarily handles V2 mode/hints and
  must not be mistaken for the five V1 tool definitions.

## Reproduction and accounting

Run from the repository root (Python 3, Git, Cargo, and the existing pinned renderer's
cached dependencies are required):

```sh
python3 scripts/generate-subagents-contract.py ~/projects/codex
python3 scripts/generate-subagents-contract.py ~/projects/codex --check
```

The first command writes `subagents-source-manifest.json` and
`subagents-supported.json` in this directory. The second regenerates and compares
parsed JSON, tolerating only formatter whitespace. The manifest pins source hashes;
the supported artifact records native tools, explicit before/after projection edits,
the supported direct contract, and native namespace-derived nested declarations with
complete return types. Like native `collect_code_mode_tool_definitions`, runtime
discovery descriptions prepend namespace guidance before augmentation; exec-prompt
sections retain unprefixed tool prose, matching the separate native prompt collector.
The TypeScript contract consumes that artifact instead of
maintaining a second handwritten copy. Generation reuses the existing pinned Rust
Code Mode declaration renderer; it does not add an execution path or change the host.

Keep source hashes and explicit capability edits with generated declarations. The
existing Code Mode source manifest and native host release identity stay unchanged;
V1's additional source ledger is separate so regenerating the original five-tool
baseline does not silently omit subagent evidence.

Provider payload measurements and direct/nested scenario execution remain #308/#278
work. This baseline only measures generated artifacts and runs the existing focused
direct behavioral checks; it does not label character estimates as provider tokens.

Generated supported direct tools currently contain **11,675 serialized characters**
(`ceil(characters / 4)` = **2,919**, not provider tokens). Full nested description
strings contain **10,258 characters** (estimate **2,565**); the serialized nested
artifact contains **33,143 characters**, including overlapping schema/declaration
metadata. That artifact is not a measured provider request or `ALL_TOOLS` history
payload. None of these figures measures initial eager V1 cues, which ship with #308.

```sh
bun -e 'import {CODEX_V1_NESTED_TOOLS,serializeCodexV1Contract,estimateCodexV1ContractTokens} from "./packages/ext/subagents/codex-v1-contract.ts"; const s=serializeCodexV1Contract(); const n=CODEX_V1_NESTED_TOOLS.reduce((sum,t)=>sum+t.runtime_description.length,0); console.log(JSON.stringify({directCharacters:s.length,directEstimatedTokens:estimateCodexV1ContractTokens(),nestedDescriptionsCharacters:n,nestedDescriptionsEstimatedTokens:Math.ceil(n/4),nestedSerializedCharacters:JSON.stringify(CODEX_V1_NESTED_TOOLS).length},null,2));'
```
