# pi-bites

A small collection of personal extensions for the pi coding agent.

## What's included

- **Codex V2-style subagents** — `default`, `worker`, and `explorer` roles with
  direct tools for spawning, messaging, follow-up tasks, waiting, and interruption.
  Children inherit parent permissions and work with or without Code Mode.
  Fleet shows read-only status above the editor: up to five agent rows and an
  overflow count, with elapsed time, usage, lifecycle, residency, and pending mail.
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
- **Local prompt-cache diagnostics** — provider-agnostic, default-on rolling fingerprints;
  `/cache-debug on|off|status` controls local anomaly capture outside model context.
  See [capture limits and inspection](docs/cache-debug.md).
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

### Code Mode sessions

Code Mode works on every model. GPT models in the adapter's supported families use
Codex-shaped tools; other models use Pi's native tools nested inside Code Mode.
Selected direct tools are nested, while model-only tools such as subagents stay
direct. Tool selections and explicit Code Mode disables still apply.

Underlying tool selections are saved per branch, so resume, `/reload`, and `/tree`
preserve Code Mode capabilities without re-enabling explicitly disabled tools.
Sessions saved before selection checkpoints existed need explicit re-selection.
For a session intended to have full core access, repair it once with:

```bash
pi --resume --tools +read,+bash,+edit,+write
```

Keep read-only sessions restricted; this command grants shell and patch access.

### Subagents

Set `subagents` inside either `pi-bites.json`. Project fields override global
fields individually; omitted fields inherit global settings, then built-in behavior.

| Field                    | Built-in behavior                                                                                                   | Accepted values                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `defaultModel`           | Inherit the parent model                                                                                            | Exact authenticated `provider/model-id` or unambiguous model ID                                    |
| `defaultReasoningEffort` | Inherit parent effort; when selecting a model, use Pi's per-model/global default, then `medium`, capability-clamped | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`; must be supported by the selected model |
| `maxDepth`               | Uncapped nesting                                                                                                    | Integer 0–1024; root is depth 0, so 0 prevents children                                            |
| `maxConcurrent`          | Three children, sharing execution/residency budgets across descendants                                              | Integer 1–1024                                                                                     |
| `fleetView`              | Enabled, compact read-only Fleet                                                                                    | Boolean                                                                                            |

Explicit model/effort requests override configured defaults, then role policy
applies. All choices must respect the owning root session's authenticated model
scope; empty Pi scope permits all authenticated models. `scopeModels` is retired,
not an opt-out. There is no `/agents` settings UI or settings writer.

Settings are re-read on session start and `/reload`. Removing an effective setting
restores its built-in behavior on the next load; removing a project override exposes
any global value. Changing defaults does not replace retained children's selected
models or reasoning efforts on follow-up or runtime reload.

#### Manual cutover from `subagents.json`

Legacy `~/.pi/agent/subagents.json` and `.pi/subagents.json` are **ignored**, even
when no replacement exists. Each existing file produces a warning on session
start/reload naming its location and destination. Pi-bites never copies, rewrites,
or deletes these files. Global paths follow Pi's agent-directory override.

For example, manually replace the supported fields from a legacy global file:

```json
{ "defaultModel": "provider/model-id", "defaultReasoningEffort": "high", "maxConcurrent": 8 }
```

by merging this section into `~/.pi/agent/pi-bites.json`, preserving other sections:

```json
{
  "subagents": {
    "defaultModel": "provider/model-id",
    "defaultReasoningEffort": "high",
    "maxConcurrent": 8
  }
}
```

Likewise, legacy project settings such as `{ "maxConcurrent": 2, "fleetView": false }`
become this section in `.pi/pi-bites.json`:

```json
{
  "subagents": {
    "maxConcurrent": 2,
    "fleetView": false
  }
}
```

Here the project keeps the global model/effort but overrides concurrency. Copy only
the five supported fields above, not retired controls such as `scopeModels` or
`defaultJoinMode`; the editor schema flags them. Run `/reload` to apply. To stop the
warnings, manually archive or remove the old files after checking the cutover.

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
