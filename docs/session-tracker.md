# Session tracker

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

For an fzf picker instead of cycling, use a popup (requires `fzf`, `node`, and tmux
with `display-popup` support):

```tmux
bind-key -n M-s run-shell -b 'tmux display-popup -c "#{client_tty}" -E -w 90% -h 80% "node \"/path/to/pi-bites/bin/pi-sessions.mjs\" pick --client \"#{client_tty}\""'
```

The picker shows Pi state, tmux session/window/pane, working directory, and pane ID.
Permission/input waits come first, followed by working and idle panes. Type to
filter, press `Enter` to focus the selected pane, or `Esc` to cancel. The right side
previews that pane's visible terminal contents with colors, starting at the bottom.
Use `Ctrl-U` / `Ctrl-D` to scroll the preview up/down by half a page (mouse scrolling
and `Shift-Up` / `Shift-Down` also work); `Ctrl-R` refreshes it. The `run-shell`
wrapper expands the invoking client's tty before opening the popup; `display-popup`
does not expand formats in its shell command. This is a pane text capture, not a screenshot of the entire split window.
The picker ignores `FZF_DEFAULT_OPTS` and `FZF_DEFAULT_OPTS_FILE` so its selection
protocol and key bindings stay predictable.
The pane list and Pi states are a snapshot taken when the picker opens; reopen it
to update them. Only tracked panes present in the popup's tmux server are listed.

Adjust the script path for your installation. The helper only contacts an
already-running tracker daemon; it does not start Pi or the daemon. You can use
`bind-key s` instead of `bind-key -n M-s` for a prefix-based binding like the other
popup integrations.
