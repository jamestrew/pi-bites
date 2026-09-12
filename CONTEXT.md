# Pi Bites

Pi Bites extends Pi with small interaction and context-management features.

## Language

**At-mention expansion**:
Model context produced from one successfully resolved `@path`, identified by its resolved path and optional line range. A directory listing is also an at-mention expansion.
_Avoid_: File dump, context dump

**Injected expansion**:
An at-mention expansion actually added to the active conversation context; invalid and unchanged mentions are not injected expansions.
_Avoid_: Triggered mention

**Unchanged expansion**:
An at-mention expansion whose model-visible content matches the last injected expansion with the same resolved path and line range since the active context was last rewritten.
_Avoid_: Unmodified file

**Tracked Pi pane**:
A tmux pane currently represented in the host-local session tracker. It remains one tracked pane when Pi changes sessions within that pane.
_Avoid_: Tracked Pi session

**Tmux status segment**:
A compact, read-only summary of all host-local tracked Pi panes displayed within tmux's status line.
_Avoid_: Tmux status bar

**Code Mode**:
A tool interface in which the model composes nested tool calls using JavaScript through `exec`, and resumes yielded executions through `wait`.
_Avoid_: Notebook Mode, shell execution

**Nested tool**:
A capability the model calls from within a Code Mode execution.
_Avoid_: Subagent, child agent

**Direct tool**:
A capability exposed for the model to call directly, outside a Code Mode execution.
_Avoid_: Nested tool

**Structured mode**:
The retired Codex adapter interface that exposed its capabilities as direct structured tools; no longer an activation option.
_Avoid_: Code Mode

**Cell**:
A JavaScript execution in Code Mode that can yield and later be resumed or terminated through `wait`.
_Avoid_: Shell session

**Shell session**:
A running command that can receive input or be polled through `write_stdin`, independently of whether the cell that started it has finished.
_Avoid_: Cell

**Bash gate**:
A permission gate that classifies requested shell commands and obtains automated or human approval when required.
_Avoid_: JavaScript sandbox

**Runtime session**:
Branch-owned Code Mode state containing cells and serializable stored values; it is cleared on branch/session replacement, reload, shutdown, or leaving supported model scope.
_Avoid_: Shell session, persistent notebook

**Nested trace**:
Presentation data for an owned tool invocation rendered inside its enclosing `exec`/`wait` result. It is not an independent model-visible tool message.
_Avoid_: Injected tool result

**Contract baseline**:
The selected Codex revision plus explicit Pi capability projections, recorded in [the Code Mode baseline](docs/code-mode-contract/README.md). It specifies the active adapter interface and its supported deviations.
_Avoid_: Latest upstream, conversion prompt
