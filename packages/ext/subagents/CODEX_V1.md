# Codex V1 subagent contract

`codex-v1-contract.ts` pins the model-facing target for the subagent migration to Codex revision
`ddf8a67ab09cd76b8adc0969f11ee1271179aba7`.

## Authoritative sources

- `codex-rs/core/src/tools/handlers/multi_agents_spec.rs` — names, descriptions, parameters, and output schemas
- `codex-rs/core/src/tools/handlers/multi_agents.rs` — shared tool dispatch
- `codex-rs/core/src/tools/handlers/multi_agents_common.rs` — shared limits and helpers
- `codex-rs/core/src/tools/handlers/multi_agents/{spawn,send_input,wait,close_agent,resume_agent}.rs`
  — per-tool dispatch and result behavior
- `codex-rs/core/src/session/multi_agents.rs` — lifecycle and role-instruction behavior
- `codex-rs/core/src/agent/role.rs` — built-in role names and descriptions
- `codex-rs/core/templates/collab/experimental_prompt.md` — V1 orchestration guidance

The checkout in `~/projects/codex` is a reference only. Pi-bites does not import it or
`packages/ext/codex-adapter/` at runtime.

## Target surface

| Tool           | Required input      | Output                                  |
| -------------- | ------------------- | --------------------------------------- |
| `spawn_agent`  | `message`           | `agent_id`, nullable `nickname`         |
| `send_input`   | `target`, `message` | `submission_id`                         |
| `wait_agent`   | `targets`           | statuses keyed by agent id, `timed_out` |
| `close_agent`  | `target`            | `previous_status`                       |
| `resume_agent` | `id`                | `status`                                |

An agent status is one of `pending_init`, `running`, `interrupted`, `shutdown`, or `not_found`, or
an object containing nullable `completed` output or an `errored` message. The exact schemas and
descriptions live in `codex-v1-contract.ts`; its serialized SHA-256 fixture makes drift explicit.

The built-in roles are `default`, `worker`, and `explorer`. They inherit the parent's tools, model,
and reasoning effort unless the caller explicitly overrides supported settings.

## Lifecycle and role semantics

- `fork_context: true` forks the parent's full thread history. A full-history fork inherits the
  parent role and rejects an `agent_type` override.
- Without a full-history fork, omitting `agent_type` selects `default` and the child starts with only
  its initial prompt.
- `explorer` is guidance, not a permission boundary; it receives the inherited tool set.
- A spawned agent reserves concurrency until `close_agent`, including after completion. A spawn that
  cannot reserve a slot fails instead of entering an invisible queue.
- `wait_agent` and the asynchronous completion notification are independent delivery channels. A
  waiter may therefore observe the same completed status that is also sent in a notification.

## Intentional pi adaptations

- Pi uses ordinary top-level tools rather than the Codex Responses `multi_agent_v1` namespace.
- `items` is omitted from `spawn_agent` and `send_input`. Pi has no need for the Responses-specific
  structured text/image/audio/skill/mention union, so plain-text `message` is required.
- Pi tool definitions cannot send output schemas to the model. The pinned output schemas therefore
  specify and test the JSON returned by implementations and remain part of the budget measurement.

## Token budget

The pre-migration baseline is approximately **1,605 tokens**: `Agent` 1,200, `WaitAgent` 169, and
`MessageAgent` 236. The soft final budget for all five tools is **2,000 tokens**.

The contract test serializes every tool name, description, parameter schema, output schema, and the
role guidance embedded in `spawn_agent`, then applies Pi's conservative `ceil(characters / 4)`
estimate. The pinned V1 contract currently measures **1,902 tokens**. Later migration issues should
update the fixture and this number only for deliberate model-facing changes.
