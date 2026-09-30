# pi-bites

A small collection of personal extensions for the pi coding agent.

## What's included

- Direct V2 subagents (`default`, `worker`, and `explorer` roles)
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

## Subagents

The six direct tools are `spawn_agent`, `send_message`, `followup_task`, `wait_agent`,
`interrupt_agent`, and `list_agents`, on every tool-calling model. They stay direct
with Code Mode active and with `disable: ["codexAdapter"]`. Disable them with
`disable: ["subagents"]` and reload; selected tools and inherited parent permissions
still restrict children, including across provider switches.

Spawn requires `task_name` and `message`; `fork_turns` defaults to `all` (`none` or a
positive integer string selects fresh/recent history). Use canonical `/root/...`
paths for parent/sibling messages. `send_message` queues information without waking
idle work; `followup_task` assigns another task. `wait_agent` observes mailbox activity,
not selected agent IDs. Completion releases execution capacity; retained identities
remain addressable even when idle runtimes unload. `/agents` and Fleet show live and
retained conversations. Saved displays do not restore live agents.

Subagents inherit the caller's model unless `model` is supplied or `defaultModel`
is configured in `~/.pi/agent/subagents.json` or project `.pi/subagents.json`.
`defaultReasoningEffort` sets the corresponding effort default; explicit spawn fields
win over these defaults. Use exact `provider/modelId` values (or an unambiguous exact
model ID), not fuzzy names. Selecting a model without an effort override resets effort
to Pi's default for that model; otherwise effort is inherited. Applied role settings
win last, but the built-in roles currently have no model/effort overrides.

See [the V2 contract](packages/ext/subagents/CODEX_V2.md) and
[cutover verification](docs/code-mode-contract/subagents-v2-cutover.md) and
[release validation and remaining live gaps](docs/code-mode-contract/subagents-v2-validation.md).

## Installation

```bash
pi install git:github.com/jamestrew/pi-bites
```

For exact release pins and the compatibility policy, see [Releases](RELEASES.md).

Parent Code Mode requires Pi 0.99.1 or newer and needs no standalone V8 host.
SDK children still need the standalone host on Linux x64 or arm64 until their
separate migration; the Pi package does not download it automatically. From the pi-bites
checkout (or the installed package directory), run:

```bash
bash scripts/code-mode-install.sh
# Or install it in another directory:
bash scripts/code-mode-install.sh --install-dir "$HOME/bin"
```

This installs `codex-code-mode-host`, which includes the required V8 runtime;
you do **not** need to install V8 separately. Restart Pi, or run `/reload`
after changing `PATH`. To use pi-bites without Code Mode, add
`"codexAdapter"` to the `disable` list instead.

## Development

Pi-bites builds and tests against Pi 0.99.1. `bun run dev` keeps extension discovery
isolated with `--no-extensions`, then explicitly loads only `builtin:codemode`,
`builtin:tool-search`, and the local pi-bites extension. Eligible parent GPT sessions
select native `codemode`; `tool_search` remains separately enabled, for example
with `defaultTools: ["+tool_search"]`. Loading search does not grant capabilities.

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

`codexAdapter` exposes native Code Mode through `codemode` in parent sessions for GPT-5.6 and GPT-6 base IDs and hyphenated variants, plus GPT-6.1 base and Sol IDs. The five owned capabilities—`exec_command`, `write_stdin`, `apply_patch`, `web_run`, and `view_image`—are callable inside native JavaScript, subject to session selection and availability. Unrelated direct tools remain available. Other model families use normal Pi core tools, with no standalone adapter web tool.

Native discovery exposes permitted tools through `searchTools`, `describeTool`, and `ALL_TOOLS`. Web help is loaded on demand through `text(await describeTool("web_run"));` before browsing, including after compaction removes previously loaded help. Initial guidance retains browsing triggers. Discovery is documentation only and does not enable unavailable web routes or credential fallback. It leaves tool definitions and the system prompt stable; it does not guarantee provider cache savings.

Recognized model-ID prefixes are `openai/`, `openai-codex/`, `azure/`, `azure-openai/`, `github-copilot/`, and `openrouter/`. A provider name alone never enables the adapter. The obsolete `codexAdapter.providers` option has been removed; existing unknown configuration keys are ignored, so it no longer selects models.

Commands still pass through bash-gate and Auto Mode individually, after validation and before launch. Pi owns native nested operation/error rows and expansion. Scripts complete once; there are no yielded cells or outer `wait` calls. A returned shell session can still be polled with `tools.write_stdin` in a later script. Normal completion preserves these shells; explicit cancellation cleans up only shells launched by that script. Unhandled script errors cancel pending calls, not already-returned shell launches. Leaving scope, navigation, replacement, reload and shutdown clear owned state. Saved transcripts restore display only. See [native parent behavior and verification](docs/code-mode-contract/native-parent.md).

Vision-capable models can use local-only `view_image({ path })`, accepting PNG, JPEG, WebP and non-animated GIF up to 32 MiB and 4096 pixels per dimension. Text-only models never receive it. Image viewing makes no hidden provider request; emit the returned image explicitly with `image(...)` to send it to the model.

Legacy `openai-codex` Responses models get nested `web_run` through their existing Pi login. Other providers are hidden by default. Trust a verified Responses provider's own `/alpha/search` endpoint by exact provider ID, or independently opt in to stock OpenAI Codex fallback:

```json
{
  "codexAdapter": {
    "webSearchProviders": ["your-verified-responses-provider"],
    "allowOpenAICodexFallback": false
  }
}
```

Pi's new `/login openai` ChatGPT subscription uses the direct OpenAI Responses grant, not the legacy Codex backend. Code Mode works with GPT-6.1 Sol on either login, but direct OpenAI subscription usage and `web_run` are not verified and remain unavailable. View subscription usage at <https://chatgpt.com/settings/usage>. Repeating `/login openai` does not enable these capabilities. Existing `/login openai-codex` credentials remain usable; no migration is required. The `openai` provider cannot opt into `webSearchProviders`; configure a verified proxy under its own provider ID. Explicit fallback uses the separately authenticated legacy account, never the direct OpenAI token. See [route verification and limits](docs/code-mode-contract/openai-compatibility.md).

`allowOpenAICodexFallback` defaults to `false`. Set it to `true` only where sending explicit search/navigation arguments through personal stock Codex authentication is permitted. A selected route never retries through another provider after auth, compatibility, HTTP, or native failure. `web_run` sends no Pi conversation or project context.

Linux x86-64 and arm64 native helpers, including `view_image`, are bundled. On a missing, incompatible, or non-executable helper, rebuild it with the commands in [`packages/ext/codex-adapter/UPSTREAM.md`](packages/ext/codex-adapter/UPSTREAM.md), replace the corresponding bundled executable, and run `/reload`. Disable the adapter with `"disable": ["codexAdapter"]` when using another platform.

### Child Code Mode host dependency

Not-yet-migrated SDK children require the pinned standalone host from Codex’s GitHub release for
Linux x64 or arm64. Run `bash scripts/code-mode-install.sh` (optionally with
`--install-dir "$HOME/bin"`); see the [installation and checksum instructions](packages/ext/codex-adapter/vendor/code-mode/README.md#manual-installation).
Pi finds `codex-code-mode-host` on `PATH`, so it can be supplied by your package
manager or installed in any directory on Pi’s `PATH`. Pi never downloads it automatically. Source, checksums, notices and rebuild
instructions remain in this repository.

The parent adapter does not load or start this host; only the child path still requires it. A missing or crashed host fails visibly and keeps the Code Mode interface; install/repair the host and `/reload`, or explicitly disable `codexAdapter` to use normal Pi tools. There is no second structured adapter mode.

The retained child surface exposes `exec` and `wait`, hides the five nested adapter tools,
and preserves unrelated direct tools. It respects session tool selection and
restores only displaced core tools on leaving scope. Stock Pi sends raw JavaScript
through grammar tools where the actual API/model supports them; other routes send
`{"code":"..."}` through the stock structured fallback. Details and reproducible
contract generation are in [the integration record](docs/code-mode-contract/activation.md). See [cutover validation and live smoke instructions](docs/code-mode-contract/cutover.md) for coverage and route availability.

## Disabling extensions

Use slash commands inside pi:

```text
/bites:list
/bites:off statusline
/bites:on statusline
```

Changes take effect the next time pi starts. Valid extension names are:

```text
bashGate, autoMode, statusline, tokenCount, usageDashboard, context, tools, explore, fzf, notifications, autoCompaction, spotme, inlineReferences, promptNormalization, atMentionContext, ponytail, view, goal, codexAdapter
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

The bundled reviewer policy adopts synchronous Codex Guardian: low/medium risk defaults to allow even with weak authorization, except explicit security-policy denials and affirmative malicious prompt injection. High risk requires at least medium authorization, narrow scope, and no absolute deny; critical risk defaults to deny. Assessments include intrinsic risk, user authorization, outcome, and rationale. Pi Bites supplies no sandbox or reviewer investigation tools. See the [pinned contract and adaptations](packages/ext/automode/UPSTREAM.md).

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

The reviewer reuses bounded conversation history and incremental evidence, with isolated concurrent forks and resets on incompatible session, model, policy, or context changes. Provider cache hits are not guaranteed. See [repeatable live evaluation and results](docs/automode-evaluation.md); ordinary tests never make paid review calls.

`autoMode.policy` still replaces the bundled policy in full (it is not an additive rule); omit it to adopt Guardian defaults. Existing model and thinking settings need no migration. Custom policies use the same validated JSON assessment contract, including compatibility with outcome-only replies.

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
