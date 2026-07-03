# pi-bites

A small collection of personal extensions for the pi coding agent.

## What's included

- `explore` subagent tool
- Less noisy `read` tool output
- Tweaked `read` tool description/output to keep file reads less noisy
- Configurable bash command gate
- RTK command rewriting for assistant `bash` tool calls and user `!` shell commands
- Better fuzzy finding for `@` file mentions powered by `fd` and Snacks/fzf-inspired scoring
- Script-driven statusline
- Token-count/status helpers
- `/usage` dashboard for session cost/token statistics
- Custom todo and question tools
- Optional notifications
- Session-scoped `/rollback` checkpoints for Pi-authored `edit`/`write` changes
- `spotme` gym mode that periodically makes the agent scaffold a coding exercise for you to implement
- Inline `$skill:name` / `$prompt:name` references with hidden context injection

## Installation

```bash
pi install git:github.com/jamestrew/pi-bites
```

## Configuration

`pi-bites` reads JSON config from two places:

- Global: `~/.pi/agent/pi-bites.json`
- Project-local: `<project>/.pi/pi-bites.json`

Project-local settings override global settings for each config section. `disable` lists are unioned, so a globally disabled extension is disabled in every project.

Example:

```json
{
  "explore": {
    "defaultModel": "anthropic/claude-sonnet-4-5",
    "defaultTools": "read,ls,bash"
  },
  "statusline": {
    "command": "python get_usage_limits.py"
  },
  "notifications": {
    "command": "notify-send 'pi'"
  },
  "ponytail": {
    "defaultMode": "full"
  },
  "bashGate": {
    "rules": [{ "cmd": "bun", "subcommands": ["check", "test"] }, { "cmd": "pytest" }]
  },
  "disable": ["tokenCount"]
}
```

## Disabling extensions

Use slash commands inside pi:

```text
/bites:list
/bites:off statusline
/bites:on statusline
```

Changes take effect the next time pi starts. Valid extension names are:

```text
bashGate, rtk, statusline, tokenCount, usageDashboard, tools, explore, fzf, todo, question, notifications, rollback, spotme, inlineReferences, promptNormalization, atMentionContext, ponytail
```

You can also edit config directly:

```json
{
  "disable": ["bashGate", "notifications"]
}
```

## Rollback checkpoints

Run `/rollback` inside pi to restore files Pi changed with tracked `edit` and `write` tool calls back to an earlier checkpoint in the current session.

Rollback snapshots are stored outside the project repository under pi's agent directory and use an internal Git object store. They do not touch your project's `.git`, stash stack, branches, commits, or index. Checkpoints are scoped by both cwd and Pi session ID, so multiple Pi agents in the same directory do not share rollback history.

Before restoring, `/rollback` shows the files that will be affected and asks for confirmation. Only files Pi touched through tracked mutation tools are eligible.

To disable checkpoint tracking:

```json
{
  "rollback": { "enabled": false }
}
```

Or disable the extension entirely with `/bites:off rollback`.

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

## Bash gate

The bash gate prompts before running `bash` tool commands that match one of the built-in destructive rules or one of your configured structured rules.

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

For non-interactive runs, matching commands are blocked by default because there is no UI prompt. Use `--yolo` to bypass the gate entirely:

```bash
pi --yolo -p "run the checks"
```
