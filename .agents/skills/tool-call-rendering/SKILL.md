---
name: tool-call-rendering
description: Tool rendering for pi extensions. Use whenever implementing or reviewing renderCall, renderResult, tool status/message rows, collapsed previews, expansion behavior, or renderer tests. Applies the repo's scanline grammar, semantic parameter summaries, TUI-safe truncation, and explicit semantic exceptions.
---

# Tool rendering

Make tool activity recognizable at a glance without flattening information that needs a richer visual form.

## 1. Inspect the whole row

Read the registration, `renderCall`, `renderResult`, shared helpers, and focused tests. Compare sibling renderers before introducing a new helper. Account for call-time, partial, final, restored-session, collapsed, and expanded states.

Assign visible content deliberately:

- Prefer `renderCall` for a stable row; let `renderResult` update `context.state` and return an empty `Container` when completion only changes that row.
- Use `renderResult` as the owner when no honest call-time summary exists and the result state is the subject.
- Reuse an inherited or installed built-in renderer when its behavior already fits.

This step is complete when every lifecycle state has one intentional owner and no state duplicates the row.

## 2. Build the scanline

The **scanline** is the first visible line and the shared grammar for every state:

- Begin at column zero with the registered tool name or a concrete action. The first word must identify the tool or action.
- Render that first word with `theme.bold(...)` in the default foreground, matching pi's built-in `read` renderer.
- Render the remainder of the line with `theme.fg("accent", ...)`, which is cyan by default.
- Use plain, space-separated text for an ordinary scanline. Reserve arrows and status glyphs for relationships they clarify rather than as decoration.
- Omit decorative prefixes and ordinary indentation so the bold word remains the scan anchor.
- Keep an action word stable for the row's entire lifecycle: `Edit` remains `Edit` after completion rather than becoming `Edited`. Put completion state in the remainder or details.
- When both `renderCall` and `renderResult` produce a row, build their scanline through one formatter so their grammar cannot drift.

Represent parameters semantically: use a path, target, count, summary, or short sentence that explains the action. If no safe summary exists, the styled tool name alone is preferable to serialized arguments. Raw JSON is not a finished renderer.

## 3. Add details and collapsing

When details follow the scanline, insert one blank line, begin ordinary detail lines at column zero, and dim them with `theme.fg("dim", ...)`. On failure, preserve the same scanline and detail styles; rely on the host's red tool-call background. Add a concise error message in the details when it helps diagnosis.

Separate a trailing status such as elapsed time from preceding command output with one blank line. Do not add another blank line when the status is the only detail.

Collapse most output to the first 5–10 display lines; use 8 when there is no better semantic boundary. If collapsed content is hidden, append a dim `(${keyHint("app.tools.expand", "to expand")})` as the final rendered detail line, after output and trailing statuses, so the expansion hint is always at the bottom. Omit the hint when everything is already visible. Expanded mode exposes all available display content.

Display collapsing and execution/context truncation solve different problems. Keep pi's truncation utilities and retrievable full-output location for large results even when the renderer also supports expansion.

Sanitize model-controlled text. Use `new Text(text, 0, 0)` or another width-aware component, and keep each rendered line within the supplied visible width.

## 4. Preserve semantic exceptions

Depart from ordinary body styling when visual structure carries domain meaning, such as syntax-colored diffs, line numbers, or tree branches. Keep the scanline, compact collapse behavior, semantic summaries, configurable key hint, safe width, and lifecycle ownership unless one of those properties directly conflicts with the information being represented. Capture the reason in a focused test rather than a broad explanatory comment.

Use style-visible theme markers in focused tests so bold, accent, and dim behavior are observable. Test width separately with a theme whose markers do not alter visible width. Cover the lifecycle and width states affected by the change, then run `bun check`. The renderer is complete when every changed state follows the scanline grammar or demonstrates a tested semantic reason to depart from it.
