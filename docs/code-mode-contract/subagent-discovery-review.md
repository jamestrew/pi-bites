# Local subagent discovery review

Local findings below concern **pi-bites local implementation only**, including its
vendored runtime. The separate upstream section records parent-verified evidence;
this explorer did not inspect `../codex`.

## Findings

- **Targeted progressive retrieval is technically supported.** `ALL_TOOLS` is an
  ordinary V8 array of enabled `{ name, description }` entries, built independently
  from the callable `tools` object. Filtering one exact name returns just that
  entry; later cells can retrieve other entries. The vendored generic guidance
  explicitly says to filter by name and description.
  Sources: `packages/ext/codex-adapter/vendor/code-mode/crates/code-mode/src/runtime/globals.rs:22-37,52-101`;
  `packages/ext/codex-adapter/vendor/code-mode/crates/code-mode-protocol/src/description.rs:10-11`.

  ```js
  text(ALL_TOOLS.filter((t) => t.name === "multi_agent_v1__spawn_agent"));
  ```

- **Current local model-facing policy instead requires namespace-wide discovery
  before collaboration.** The exact instruction is “Before using collaboration,
  retrieve and read the complete generated input/return declarations in a separate
  exec call”, followed by
  `text(ALL_TOOLS.filter((tool) => tool.name.startsWith("multi_agent_v1__")));`.
  It also requires rediscovery when declarations leave context, including
  compaction. With all capabilities enabled this retrieves all five declarations;
  strictly, it retrieves all _enabled_ matching entries, not unavailable tools.
  This guidance is injected whenever any nested V1 name is present.
  Sources: `packages/ext/codex-adapter/code-mode/contracts.ts:22-40,68-74`.
  The same namespace-wide example and read-before-use policy appear in
  `packages/ext/subagents/CODEX_V1.md:303-321`.

- **This is an instruction policy, not a discovery-dependent runtime unlock.**
  Each execution receives its enabled tools and their metadata; global installation
  creates callable functions without checking which descriptions were printed.
  Dispatch checks current availability, not a discovery receipt. Thus the targeted
  example above demonstrates the mechanism, but does not replace the current
  collaboration instruction's namespace-wide prerequisite.
  Sources: `packages/ext/codex-adapter/code-mode/runtime.ts:113-141`;
  `packages/ext/codex-adapter/vendor/code-mode/crates/code-mode/src/runtime/globals.rs:22-37,52-67`;
  `packages/ext/codex-adapter/code-mode/nested-tools.ts:100-114,123-150`.

- **Complete declarations are already stored per tool.** The five supported names
  and generated nested entries come from `docs/code-mode-contract/subagents-supported.json`;
  `nativeTools` assigns each tool's `runtime_description`, input schema, output
  schema, and native namespace identity. Initial help adds the collaboration cue,
  not the five detailed declarations. No Responses tool-search step is required.
  Sources: `packages/ext/subagents/codex-v1-contract.ts:1-17`;
  `packages/ext/codex-adapter/code-mode/contracts.ts:31-58`;
  `docs/code-mode-contract/README.md:268-275`.

- **Exposure follows selection rather than an unconditional five-tool bundle.**
  Projection nests selected subagent controls only when both outer `exec` and
  `wait` are available, displacing their direct equivalents. Discovery does not
  expand availability or authorize spawning; the eager guidance retains explicit
  permission requirements. The integration test verifies namespace discovery
  returns all five in its full-capability fixture, starts no agent, leaves provider
  tool definitions unchanged, and can be repeated.
  Sources: `packages/ext/codex-adapter/activation.ts:118-145`;
  `packages/ext/codex-adapter/code-mode/contracts.ts:68-74`;
  `packages/ext/codex-adapter/code-mode-subagents.test.ts:129-150,172-174`.

## Bottom line

The local runtime supports per-tool progressive lookup; the local collaboration
prompt currently prescribes retrieving the entire enabled V1 namespace first.
The precise policy owner is `subagentDiscoveryGuidance` in
`packages/ext/codex-adapter/code-mode/contracts.ts:68-74`, not the `ALL_TOOLS` array
implementation. No code was changed.

## Upstream comparison (parent-verified inspection)

The following evidence was supplied by the parent, not independently re-read here.
Checkout: `../codex`, HEAD `1a89aec960cd92e2c59ce49b7f3c3347a915e4a9`,
dated 2026-09-26. Paths below are relative to `../codex/codex-rs/`.

- Version selection prioritizes explicit `MultiAgentV2`, then agents-disabled,
  then `model.multi_agent_version`, then feature fallback
  (`core/src/config/mod.rs:1577-1604`). Feature defaults are `multi_agent: true`,
  V2 false (`features/src/lib.rs:1320-1330`).
- Bundled model metadata selects V2 for `gpt-6-{astra,sol,luna}`,
  `gpt-5.6-{sol,terra}`, and daybreak blue/red; V1 for `gpt-5.6-luna` and
  `codex-auto-review`; `gpt-5.5` is null (`models-manager/models.json`; line
  numbers were not supplied).
- Both versions remain implemented (`core/src/tools/spec_plan.rs:1300-1424`). V2 defaults to
  direct-only through `non_code_mode_only: true` (`core/src/config/mod.rs:1359`);
  V1 is deferred when search is supported and otherwise Direct
  (`core/src/tools/spec_plan.rs:1300-1424`).
- Generic Code Mode discovery explicitly permits filtering `ALL_TOOLS` by
  name/description (`code-mode-protocol/src/description.rs:16-17`). Tool search
  uses a BM25 query plus limit and exposes matching deferred tools on the next
  model call (`core/src/tools/handlers/tool_search_spec.rs:18-35,100-110`); the capability gate requires
  `supports_search_tool` and namespace tools (`core/src/tools/spec_plan.rs:653-655`).

These parent-verified upstream facts are separate from pi-bites' locally imposed
namespace-wide V1 discovery instruction identified above.
