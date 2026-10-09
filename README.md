# pi-bites

A small collection of personal extensions for the pi coding agent.

## What's included

- **Codex V2-style subagents** — `default`, `worker`, and `explorer` roles with
  direct tools for spawning, messaging, follow-up tasks, waiting, and interruption.
  Children inherit parent permissions and work with or without Code Mode.
- **Codex-shaped tools for GPT models** — shell sessions, patches, web browsing,
  and local image viewing inside Pi's native `codemode`.
- **Automode** — model-reviewed bash-gate approvals for the main agent and
  subagents, using a Codex Guardian-style policy. `Alt+Y` cycles manual, YOLO,
  and Auto modes.
- **Fixed-token auto-compaction** — defaults to 200,000 tokens, or 85% of the
  model's context window if that's lower.
- **Inline context** — `$` completion for `$skill:name` and `$prompt:name`;
  `@path` inlines file contents or directory listings. Context loads without
  expanding the visible prompt.
- **`/usage` and `/context`** — session cost/token statistics and a breakdown of
  the active context window.
- **FFF-powered `@` file search** — fuzzy workspace file ranking, with Pi's
  normal completion as a fallback.
- **Session tracker** — track Pi panes across tmux sessions, with a status-line
  summary and a fuzzy pane picker.

## Installation

```bash
pi install git:github.com/jamestrew/pi-bites
```

Code Mode requires Pi 0.99.1 or newer.

## Configuration

All settings are optional. Configure globally in `~/.pi/agent/pi-bites.json` or
per project in `.pi/pi-bites.json`. Project values override global values within
each section; `disable` lists are unioned.

```json
{
  "$schema": "https://raw.githubusercontent.com/jamestrew/pi-bites/master/pi-bites.schema.json",
  "bashGate": {
    "mode": "auto"
  },
  "autoMode": {
    "thinking": "low"
  },
  "autoCompaction": {
    "thresholdTokens": 200000
  },
  "disable": ["notifications", "spotme"]
}
```

Automode uses the active model unless `autoMode.model` is set to a
`provider/model-id`. To use normal Pi tools instead of Codex-shaped tools, add
`"codexAdapter"` to `disable`.

See the [configuration schema](pi-bites.schema.json) for all options and extension
names. `/bites:list`, `/bites:off <name>`, and `/bites:on <name>` manage extensions;
changes take effect on the next launch.

## Tmux integration

Add this to `.tmux.conf` after any theme or plugin that sets `status-right`:

```tmux
set -ag status-right ' #(dir=/tmp/pi-session-tracker-$(id -u); read -r pid < "$dir/session-tracker.pid" 2>/dev/null && kill -0 "$pid" 2>/dev/null && cat "$dir/session-tracker.status" 2>/dev/null) '
```

The segment shows `π` total Pi panes, `!` permission waits, `?` input waits, and
`▶` working panes. It stays empty when the tracker daemon is not running.

For an `Alt+S` pane picker with a terminal preview (requires `fzf`, `node`, and tmux popup support):

```tmux
bind-key -n M-s run-shell -b 'tmux display-popup -c "#{client_tty}" -E -w 90% -h 80% "node \"/path/to/pi-bites/bin/pi-sessions.mjs\" pick --client \"#{client_tty}\""'
```

Replace `/path/to/pi-bites` with your installation path. Type to filter, `Enter`
to focus a pane, or `Esc` to cancel. These integrations use an already-running
tracker; they do not start Pi or the daemon.

See [session-tracker details](docs/session-tracker.md) for cycling instead of picking,
preview controls, and refresh options.
