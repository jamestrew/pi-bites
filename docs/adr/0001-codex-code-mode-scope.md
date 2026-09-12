# Replace the structured Codex adapter with scoped Code Mode

Status: Accepted (2026-09-09), epic [#294](https://github.com/jamestrew/pi-bites/issues/294). Contract finalized by [#295](https://github.com/jamestrew/pi-bites/issues/295); implemented through #296–#302. See [cutover validation](../code-mode-contract/cutover.md) for evidence and live-route limitations.

Source definitions and supported deviations: [Code Mode contract baseline](../code-mode-contract/README.md).

For the GPT-5.6 and GPT-6 model families, including their named variants, replace the structured adapter interface with Codex-compatible Code Mode, initially nesting only `exec_command`, `write_stdin`, `apply_patch`, `web_run`, and `view_image`, subject to their availability policies. Preserve unrelated direct tools, including the three subagent tools; adapting and potentially nesting those tools belongs to separate work. Models outside this scope use Pi's regular core tools rather than retaining a second structured Codex mode; remove the existing exception that exposes standalone `web_run` outside adapter scope.

GPT-5.6 and GPT-6 are the primary usage target. Keep unsupported-model handling to a simple fallback, and do not automatically activate future GPT families or all models belonging to a configured provider.

Preserve Codex-compatible JavaScript execution, tool signatures, and yielding while permitting documented Pi-specific output delivery differences. Exact harness parity would expand the work beyond the adapter; UI feedback followed by model-visible output at a yield is acceptable instead of immediate model-visible `notify()` delivery.

Use Codex's model-facing tool descriptions and contracts from one pinned revision as the source of truth, with one-for-one fidelity wherever supported rather than locally rewritten summaries or additional batching advice. Align straightforward behavioral differences such as defaults, and make only necessary, documented omissions for unsupported capabilities; do not advertise Codex sandbox enforcement or hosted web operations that Pi-bites does not implement. Codex's broader model instruction templates are distinct from its tool descriptions.

This supersedes issue #226's exclusion of Code Mode and its required runtime, while retaining stock Pi providers and authentication, additive prompts, independent web-routing policy, and the exclusion of Notebook Mode and unrelated upstream product features. Code Mode activation on a work provider does not authorize fallback to personal OpenAI credentials.

Retain bash-gate command classification and its automated-review or permission-UI paths for nested shell execution. RTK retirement was the separate prerequisite #292, completed in ancestor commit `6dc4c867`; the new dispatcher must not reintroduce its command-rewriting or output-filtering machinery.

The selected contract revision is Codex `rust-v0.145.0` / `25af12f7e61572b0bc18ddb1008be543b91519b0`, paired with conversion 3.0.31 / `94eb6c0745e2f516bf19603f912f7b6478b43355`. Extract exact source definitions and use the pinned description builder at build time. Retain stock Pi grammar capability detection and its documented `{code:string}` fallback. The baseline explicitly records the local `web_run` alias, original-only image helper, and supported output adaptations.
