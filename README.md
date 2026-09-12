# pi-bites

A small collection of personal extensions for the pi coding agent.

## What's included

- `explore` subagent tool
- Less noisy `read` tool output
- Tweaked `read` tool description/output to keep file reads less noisy
- Configurable bash command gate
- Optional model-reviewed automode for bash-gate approvals
- Better fuzzy finding for `@` file mentions powered by `fff`
- Script-driven statusline
- Token-count/status helpers
- Fixed-token auto-compaction (150k tokens by default)
- `/usage` dashboard for session cost/token statistics
- `/context [all]` breakdown of the active context window
- Optional notifications
- `spotme` gym mode that periodically makes the agent scaffold a coding exercise for you to implement
- Inline `$skill:name` / `$prompt:name` references with hidden context injection
- Codex-style `/goal` workflow with persisted goals and automatic continuation

## Installation

```bash
pi install git:github.com/jamestrew/pi-bites
```

## Configuration

`pi-bites` reads JSON config from two places:

- Global: `~/.pi/agent/pi-bites.json`
- Project-local: `<project>/.pi/pi-bites.json`

Project-local settings override global settings for each config section. `disable` lists are unioned, so a globally disabled extension is disabled in every project. `smallModel` provides a shared cheap model selection for lightweight tasks and defaults to GitHub Copilot's Claude Haiku 4.5 with low thinking.

Example:

```json
{
  "smallModel": {
    "model": "github-copilot/claude-haiku-4.5",
    "thinking": "low"
  },
  "statusline": {
    "command": "python get_usage_limits.py"
  },
  "notifications": {
    "command": "notify-send 'pi'"
  },
  "autoCompaction": {
    "thresholdTokens": 150000
  },
  "bashGate": {
    "mode": "manual",
    "rules": [{ "cmd": "bun", "subcommands": ["check", "test"] }, { "cmd": "pytest" }]
  },
  "autoMode": {
    "thinking": "low"
  },
  "disable": ["tokenCount"]
}
```

`autoCompaction.thresholdTokens` is an absolute context-size limit, independent of the model's context window and Pi's `compaction.reserveTokens`. Pi's native overflow protection still applies for models with smaller context windows.

### Codex adapter

`codexAdapter` exposes Code Mode through `exec` and `wait` for GPT-5.6 and GPT-6 base IDs and hyphenated variants. The five owned capabilities—`exec_command`, `write_stdin`, `apply_patch`, `web_run`, and `view_image`—are callable inside `exec`, subject to session selection and availability. Unrelated direct tools remain available. Other model families use normal Pi core tools, with no standalone adapter web tool.

Recognized model-ID prefixes are `openai/`, `openai-codex/`, `azure/`, `azure-openai/`, `github-copilot/`, and `openrouter/`. A provider name alone never enables the adapter. The obsolete `codexAdapter.providers` option has been removed; existing unknown configuration keys are ignored, so it no longer selects models.

Commands still pass through bash-gate and Auto Mode individually, after argument construction and before launch. Nested activity uses the existing tool renderers; raw JavaScript is hidden, and expansion shows nested details. A cell resumed with `wait` is distinct from a shell session resumed with `tools.write_stdin`. Normal completed cells can leave background shells. Explicit cancellation cleans up that cell's shells; leaving supported scope, tree navigation, replacement, reload and shutdown clear runtime state and owned processes. Saved transcripts restore display only.

Vision-capable models can use local-only `view_image({ path })`, accepting PNG, JPEG, WebP and non-animated GIF up to 32 MiB and 4096 pixels per dimension. Text-only models never receive it. Image viewing makes no hidden provider request; emit the returned image explicitly with `image(...)` to send it to the model.

Stock `openai-codex` Responses models get nested `web_run` through their existing Pi login. Other providers are hidden by default. Trust a verified Responses provider's own `/alpha/search` endpoint by exact provider ID, or independently opt in to stock OpenAI Codex fallback:

```json
{
  "codexAdapter": {
    "webSearchProviders": ["your-verified-responses-provider"],
    "allowOpenAICodexFallback": false
  }
}
```

`allowOpenAICodexFallback` defaults to `false`. Set it to `true` only where sending explicit search/navigation arguments through personal stock Codex authentication is permitted. A selected route never retries through another provider after auth, compatibility, HTTP, or native failure. `web_run` sends no Pi conversation or project context.

Linux x86-64 and arm64 native helpers, including `view_image`, are bundled. On a missing, incompatible, or non-executable helper, rebuild it with the commands in [`packages/ext/codex-adapter/UPSTREAM.md`](packages/ext/codex-adapter/UPSTREAM.md), replace the corresponding bundled executable, and run `/reload`. Disable the adapter with `"disable": ["codexAdapter"]` when using another platform.

### Code Mode host dependency

Code Mode requires the pinned standalone host from Codex’s GitHub release for
Linux x64 or arm64. Run `bash scripts/code-mode-install.sh` (optionally with
`--install-dir "$HOME/bin"`); see the [installation and checksum instructions](packages/ext/codex-adapter/vendor/code-mode/README.md#manual-installation).
Pi finds `codex-code-mode-host` on `PATH`, so it can be supplied by your package
manager or installed in any directory on Pi’s `PATH`. Pi never downloads it automatically. Source, checksums, notices and rebuild
instructions remain in this repository.

The default adapter requires this host. A missing or crashed host fails visibly and keeps the Code Mode interface; install/repair the host and `/reload`, or explicitly disable `codexAdapter` to use normal Pi tools. There is no second structured adapter mode.

The surface exposes `exec` and `wait`, hides the five nested adapter tools,
and preserves unrelated direct tools. It respects session tool selection and
restores only displaced core tools on leaving scope. Stock Pi sends raw JavaScript
through grammar tools where the actual API/model supports them; other routes send
`{"code":"..."}` through the stock structured fallback. Details and reproducible
contract generation are in [the integration record](docs/code-mode-contract/activation.md). See [cutover validation and live smoke instructions](docs/code-mode-contract/cutover.md) for coverage and route availability.

## CodeGraph exploration

When `codegraph --version` succeeds on `PATH`, pi-bites registers `codegraph_explore({ query, maxFiles? })` as the primary tool for unfamiliar code understanding. Install the standalone CodeGraph CLI separately and run `codegraph init` in your repository; installing after startup requires `/reload`. No SDK, MCP server, instruction-file edits, or watcher is used.

Each call finds the nearest ancestor with a `.codegraph/` index from the session cwd, syncs it, then explores. Calls are serialized per indexed root, and `maxFiles` accepts 1–20 (omit it for adaptive results). Missing indexes fall back to built-in tools with initialization guidance. Large output is truncated to Pi's standard limits with a full-output temporary file.

Freshness is best effort if an external CodeGraph process holds `.codegraph/codegraph.lock`: CodeGraph 1.6 can skip sync yet report success indistinguishable from a clean no-op. Serialization prevents contention only among this extension's own calls.

Use CodeGraph's Linux x64 distribution on Ubuntu, any working `codegraph` on `PATH` on NixOS, or Linux arm64 on a 64-bit Raspberry Pi OS/userspace; upstream does not support 32-bit ARM. Disable with `"disable": ["codegraph"]`.

## Disabling extensions

Use slash commands inside pi:

```text
/bites:list
/bites:off statusline
/bites:on statusline
```

Changes take effect the next time pi starts. Valid extension names are:

```text
bashGate, autoMode, statusline, tokenCount, usageDashboard, context, tools, explore, fzf, notifications, autoCompaction, spotme, inlineReferences, promptNormalization, atMentionContext, ponytail, view, goal, codexAdapter, codegraph
```

You can also edit config directly:

```json
{
  "disable": ["bashGate", "notifications"]
}
```

## Goal model smoke

The real-model goal workflow is intentionally separate from `bun check`:

```bash
PI_GOAL_SMOKE_MODEL=provider/model bun run smoke:goal-model
```

It creates, works, inspects, verifies, completes, and reports usage for a temporary goal. It requires configured model/network access and leaves no repository files behind.

## Usage dashboard

Run `/usage` inside pi to open an interactive dashboard of local session usage. It reads session JSONL files from `~/.pi/agent/sessions` (or `PI_CODING_AGENT_DIR/sessions`) and summarizes cost, messages, sessions, and token counts by provider/model.

Controls: `Tab`/arrow keys switch periods, `↑`/`↓` selects providers, `Enter` expands models, `v` toggles insights, and `q` closes.

## Tmux status segment

To show a host-wide summary of tracked Pi panes, append this read-only segment to your existing tmux status line in `.tmux.conf`:

```tmux
set -ag status-right ' #(dir=/tmp/pi-session-tracker-$(id -u); read -r pid < "$dir/session-tracker.pid" 2>/dev/null && kill -0 "$pid" 2>/dev/null && cat "$dir/session-tracker.status" 2>/dev/null) '
```

Place the line after any tmux theme or plugin initialization that sets `status-right`; a later plugin setup can replace it. If the tracker daemon was already running when you upgraded pi-bites, run `/pi-sessions-restart-daemon` once from Pi to load the new projection support.

The output is `π N · !P · ?I · ▶W`: `π` counts all tracked panes, `!` counts panes waiting for permission, `?` counts panes waiting for input, and `▶` counts working panes. Zero state counters are omitted, and idle panes appear only in the `π` total. The segment stays empty when there are no tracked panes or the recorded daemon is not alive. It summarizes the host-local tracker, including panes in other tmux servers.

The shell command inside the segment only reads daemon-maintained files; it does not start Pi or the tracker daemon or change tmux options itself. It uses your existing `status-interval`. For faster refreshes, you may optionally add `set -g status-interval 5` yourself.

To make `Alt+S` focus the next tracked Pi pane even when Pi is not focused, add:

```tmux
bind-key -n M-s run-shell -b 'node "/path/to/pi-bites/bin/pi-sessions.mjs" next --from "#{pane_id}" --client "#{client_tty}"'
```

Adjust the script path when pi-bites is installed from a local checkout. The helper only contacts an already-running tracker daemon; it does not start Pi or the daemon.

## Inline references

Use `$skill:name` or `$prompt:name` anywhere in a message to attach the referenced skill or prompt template as hidden context without expanding it into the visible user prompt. Typing `$` in the TUI offers completions for available skills and prompt templates.

## SpotMe

SpotMe is a coding gym mode: every N code-writing actions, the agent scaffolds the next logical unit with a `SPOTME` marker, waits while you implement it, then reviews your work.

```text
/spotme:on [lite|medium|hard] [--every N]
/spotme:status
/spotme:rep
/spotme:done
/spotme:hint
/spotme:solve
/spotme:skip
/spotme:off
```

Default difficulty is `medium`, every 2 code writes.

## Automode

Press `Alt+Y` to cycle from Bash gate mode to YOLO mode, then Auto mode. Auto mode reviews gated commands with a separate model. This covers the main agent and approval requests forwarded by prompt-policy subagents, including when no UI is available. The reviewer receives a bounded authorization transcript containing active parent-session user messages, assistant prose, and prior `bash`/`exec_command` commands. Subagent prompts and prose are explicitly untrusted agent-generated context, not human authorization. Shell commands are marked `not-reviewed`, `reviewer-approved`, `human-approved`, or `blocked`; these describe permission decisions, not process success. Tool output, non-shell calls, hidden reasoning, and generated context are omitted. A prior human approval is evidence only and never approves a later command automatically.

With an interactive UI, an explicit denial shows the rationale and lets the human allow once, export the exact command to a private temporary file, view a subagent conversation where available, or keep it denied. Without UI, denials remain blocked, and reviewer failures always fail closed without an override prompt.

Automode uses the active model by default. Select it as the initial bash permission mode and optionally give it a separate model, thinking level, or policy:

```json
{
  "bashGate": {
    "mode": "auto"
  },
  "autoMode": {
    "model": "anthropic/claude-sonnet-4-5",
    "thinking": "low",
    "policy": "Approve only actions authorized by the user and deny secret exposure or destructive actions."
  }
}
```

Automode reviews only commands that already reach an approval-producing bash gate; it does not expand Pi's permissions, override deny-policy subagents, or gate routine allowed tools. Without UI, gated commands fail closed unless `bashGate.mode` is `"auto"`.

## Bash gate

The bash gate allows a conservative set of read-only and easily reversible command patterns without prompting. Everything else requires approval, as does any allowlisted command that matches a built-in destructive rule or one of your configured structured rules. Common searches such as `grep`, `rg`, and non-mutating `find` expressions are allowed; execution and write variants such as `rg --pre`, `find -exec`, `find -delete`, and `find -fprint` require approval. Read-only GitHub CLI paths and routine local Git/Jujutsu operations are also allowed, including `git add`, `git commit`, `git pull`, `git rebase`, and their Jujutsu workflow equivalents. Commands with destructive, command-execution, or external impact, such as `git reset`, `git checkout`, `git push`, `git rebase --exec`, and `jj bookmark delete`, remain gated. Language runtimes, package scripts, and other network clients intentionally fall through to approval.

```json
{
  "bashGate": {
    "mode": "yolo",
    "rules": [
      { "cmd": "bun", "subcommands": ["check", "test"] },
      { "cmd": "sed", "flagAny": ["-i"] },
      { "cmd": "find", "flagAny": ["-delete"], "reason": "find -delete mutates files" },
      { "redirects": "any-write" }
    ]
  }
}
```

Configured rules extend the built-in destructive-command gate; they do not replace it.
`bashGate.mode` sets the initial permission mode to `"manual"` (the default), `"auto"`, or
`"yolo"`. Unlike the `--yolo` CLI flag, configured YOLO mode does not lock the mode, so
`Alt+Y` can still change it.

Supported rule fields:

- `cmd`: match a command name like `git` or `rm`
- `subcommands`: match a subcommand like `push` in `git push`
- `flagAny`: match when any listed flag is present, like `-i` or `-delete`
- `redirects`: one of `"any-write"`, `"append"`, or `"truncate"`
- `reason`: optional explanation shown in the prompt

When a command matches, pi asks whether to:

- allow it once
- allow matching commands for the rest of the session
- deny it

Press `Alt+Y` to cycle through YOLO, Auto, and Bash gate modes. The footer shows `🔥 YOLO` or `🤖 AUTO` for the active bypass/review mode, and default subagents inherit it.

For non-interactive runs, matching commands are blocked by default because there is no UI prompt. Use `--yolo` to bypass every gate:

```bash
pi --yolo -p "run the checks"
```
