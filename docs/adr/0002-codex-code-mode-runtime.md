# Use the standalone Codex host for Code Mode

Status: Accepted (2026-09-09), epic [#294](https://github.com/jamestrew/pi-bites/issues/294). Contract finalized by [#295](https://github.com/jamestrew/pi-bites/issues/295); implemented through #296–#302. See [cutover validation](../code-mode-contract/cutover.md) for evidence and live-route limitations.

Source definitions and supported deviations: [Code Mode contract baseline](../code-mode-contract/README.md).

Adopt Codex's standalone V8 host to evaluate Code Mode JavaScript, with Pi-bites executing the delegated tool calls. Owning a native runtime dependency is preferable to reimplementing Codex's JavaScript execution, helpers, and yielding behavior.

Distribute the pinned Linux x64 and arm64 host through the official Codex GitHub release. Users install it manually as a required Code Mode dependency in a versioned user data directory. Keep source provenance, checksums and license records in Git; keep the large executables out of Git. Startup never downloads a host. A missing or crashed host produces a visible failure with manual installation guidance without silently switching the tool interface; disabling the adapter remains the explicit fallback.

Packaging decision updated on 2026-09-09: this replaces the original bundled-binary decision to avoid adding approximately 90 MB of native executables to repository history.

Runtime state belongs to the current conversation branch. Leaving the supported model scope, navigating to another branch, session replacement, reload, or shutdown cancels outstanding cells, terminates adapter-owned shell sessions, and clears stored values with visible feedback; switching between supported GPT models preserves that state. Saved transcripts do not restore runtime state. This prevents inaccessible work and values from surviving after the conversation that established them is no longer active.

Cancelling an individual cell terminates shell sessions created by that cell while leaving other cells' sessions alone. Normal cell completion may leave a resumable shell session running.

Keep runtime execution, Pi-side validated/authorized dispatch, and presentation separate. Preserve the pinned host source unchanged, with packaging and Pi adaptations outside it. The host protocol does not export descriptions; the pinned library builder supplies the generation seam. Bound output and retained trace/state data, and preserve existing native/shell limits. Pi extension contexts are ephemeral: snapshot stable dependencies before asynchronous work and test stale getters that throw.
