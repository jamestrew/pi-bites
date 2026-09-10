# Use the standalone Codex host for Code Mode

Status: Accepted (2026-09-09), epic [#294](https://github.com/jamestrew/pi-bites/issues/294). Contract finalized by [#295](https://github.com/jamestrew/pi-bites/issues/295); implementation follows in #296–#302.

Source definitions and supported deviations: [Code Mode contract baseline](../code-mode-contract/README.md).

Adopt Codex's standalone V8 host to evaluate Code Mode JavaScript, with Pi-bites executing the delegated tool calls. Owning a native runtime dependency is preferable to reimplementing Codex's JavaScript execution, helpers, and yielding behavior.

Bundle pinned Linux x64 and arm64 host binaries with source provenance and license records, rather than depending on an on-demand download. A missing or crashed host produces a visible failure without silently switching the tool interface; disabling the adapter remains the explicit fallback.

Runtime state belongs to the current conversation branch. Leaving the supported model scope, navigating to another branch, session replacement, reload, or shutdown cancels outstanding cells, terminates adapter-owned shell sessions, and clears stored values with visible feedback; switching between supported GPT models preserves that state. Saved transcripts do not restore runtime state. This prevents inaccessible work and values from surviving after the conversation that established them is no longer active.

Cancelling an individual cell terminates shell sessions created by that cell while leaving other cells' sessions alone. Normal cell completion may leave a resumable shell session running.

Keep runtime execution, Pi-side validated/authorized dispatch, and presentation separate. Preserve the pinned host source unchanged, with packaging and Pi adaptations outside it. The host protocol does not export descriptions; the pinned library builder supplies the generation seam. Bound output and retained trace/state data, and preserve existing native/shell limits. Pi extension contexts are ephemeral: snapshot stable dependencies before asynchronous work and test stale getters that throw.
