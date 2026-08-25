# pi-bites

A small collection of personal extensions for the pi coding agent.

## What's included

- `explore` subagent tool
- Less noisy `read` tool output
- Tweaked `read` tool description/output to keep file reads less noisy
- Configurable bash command gate
- Optional model-reviewed automode for bash-gate approvals
- RTK command rewriting for assistant `bash` tool calls and user `!` shell commands
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
  "ponytail": {
    "defaultMode": "full"
  },
  "bashGate": {
    "rules": [{ "cmd": "bun", "subcommands": ["check", "test"] }, { "cmd": "pytest" }]
  },
  "autoMode": {
    "enabled": false
  },
  "codexAdapter": {
    "providers": ["github-copilot"]
  },
  "disable": ["tokenCount"]
}
```

`autoCompaction.thresholdTokens` is an absolute context-size limit, independent of the model's context window and Pi's `compaction.reserveTokens`. Pi's native overflow protection still applies for models with smaller context windows.

### Codex adapter

`codexAdapter` exposes `exec_command`, `write_stdin`, and `apply_patch` in place of the active core file/shell tools. It preserves unrelated tools and keeps Pi's provider, authentication, and transport unchanged.

GPT models use the adapter automatically regardless of provider, including `github-copilot/gpt-*` and Pi's stock `openai-codex` models:

```json
{}
```

To adapt every model from another provider, opt in that installation's exact provider ID (the values below are examples, not canonical Copilot or Bedrock IDs):

```json
{
  "codexAdapter": {
    "providers": ["your-copilot-provider-id", "your-bedrock-provider-id"]
  }
}
```

Configured provider matching trims and lowercases the complete provider ID. `gpt-*` model IDs and models whose provider, model ID, or API identifies them as Codex are enabled automatically. `web_run` is deliberately not included: enabling the adapter never enables an OpenAI fallback or sends work-provider requests to OpenAI.

Only Linux x86-64 native helpers are bundled. On a missing, incompatible, or non-executable helper, rebuild it with the commands in [`packages/ext/codex-adapter/UPSTREAM.md`](packages/ext/codex-adapter/UPSTREAM.md), replace the corresponding bundled executable, and run `/reload`. Disable the adapter with `"disable": ["codexAdapter"]` when using another platform.

## Disabling extensions

Use slash commands inside pi:

```text
/bites:list
/bites:off statusline
/bites:on statusline
```

Changes take effect the next time pi starts. Valid extension names are:

```text
bashGate, autoMode, rtk, statusline, tokenCount, usageDashboard, context, tools, explore, fzf, notifications, autoCompaction, spotme, inlineReferences, promptNormalization, atMentionContext, ponytail, view, goal, codexAdapter
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

Press `Alt+Y` to cycle from Bash gate mode to YOLO mode, then Auto mode. Auto mode reviews gated commands with a separate model. This covers the main agent and approval requests forwarded by prompt-policy subagents, including when no UI is available. The reviewer receives a bounded parent transcript with hidden thinking removed plus the exact command request. With an interactive UI, an explicit denial shows the rationale and lets the human allow once, allow with a remembered reason, export the exact command to a private temporary file, or keep it denied. Remembered reasons are bounded session history supplied as authorization evidence to later reviews; they never approve commands automatically. Without UI, denials remain blocked, and reviewer failures always fail closed without an override prompt.

Automode uses the active model by default. It can be enabled at startup and given a separate model, thinking level, or policy:

```json
{
  "autoMode": {
    "enabled": true,
    "model": "anthropic/claude-sonnet-4-5",
    "thinking": "low",
    "policy": "Approve only actions authorized by the user and deny secret exposure or destructive actions."
  }
}
```

Automode reviews only commands that already reach an approval-producing bash gate; it does not expand Pi's permissions, override deny-policy subagents, or gate routine allowed tools. Without UI, gated commands fail closed unless Automode is enabled in configuration.

## Bash gate

The bash gate allows a conservative set of read-only and easily reversible command patterns without prompting. Everything else requires approval, as does any allowlisted command that matches a built-in destructive rule or one of your configured structured rules. Common searches such as `grep`, `rg`, and non-mutating `find` expressions are allowed; execution and write variants such as `rg --pre`, `find -exec`, `find -delete`, and `find -fprint` require approval. Read-only GitHub CLI paths and routine local Git/Jujutsu operations are also allowed, including `git add`, `git commit`, `git pull`, `git rebase`, and their Jujutsu workflow equivalents. Commands with destructive, command-execution, or external impact, such as `git reset`, `git checkout`, `git push`, `git rebase --exec`, and `jj bookmark delete`, remain gated. Language runtimes, package scripts, and other network clients intentionally fall through to approval.

```json
{
  "bashGate": {
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
