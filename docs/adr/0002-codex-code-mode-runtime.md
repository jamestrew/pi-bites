# Use the standalone Codex host for Code Mode

Adopt Codex's standalone V8 host to evaluate Code Mode JavaScript, with Pi-bites executing the delegated tool calls. Owning a native runtime dependency is preferable to reimplementing Codex's JavaScript execution, helpers, and yielding behavior.

Bundle pinned Linux x64 and arm64 host binaries with source provenance and license records, rather than depending on an on-demand download. A missing or crashed host produces a visible failure without silently switching the tool interface; disabling the adapter remains the explicit fallback.

Runtime state belongs to the current conversation branch. Leaving the supported model scope or navigating to another branch cancels outstanding cells, terminates adapter-owned shell sessions, and clears stored values with visible feedback; switching between supported GPT models preserves that state. Saved transcripts do not restore runtime state. This prevents inaccessible work and values from surviving after the conversation that established them is no longer active.

Cancelling an individual cell terminates shell sessions created by that cell while leaving other cells' sessions alone. Normal cell completion may leave a resumable shell session running.
