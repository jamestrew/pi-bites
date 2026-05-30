# pi-bites

A small collection of personal extensions for the pi coding agent.

## What's included

- `explore` subagent tool
- Less noisy `read` tool output
- Tweaked `read` tool description/output to keep file reads less noisy
- Configurable bash command gate
- Better fuzzy finding for `@` file mentions powered by `@ff-labs/fff-node`
- Script-driven statusline
- Token-count/status helpers
- Custom todo and question tools
- Optional notifications

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
bashGate, statusline, tokenCount, tools, explore, fzf, todo, question, notifications
```

You can also edit config directly:

```json
{
  "disable": ["bashGate", "notifications"]
}
```

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
