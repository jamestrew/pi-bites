---
name: ponytail-debt
disable-model-invocation: true
description: >
  Harvest existing shortcut comments in the codebase into a debt ledger, so
  deliberate shortcuts and deferrals get tracked instead of rotting into "later
  means never". Use when the user says "ponytail debt", "/ponytail-debt",
  "what did ponytail defer", "list the shortcuts", "ponytail ledger", or
  "what did we mark to do later". One-shot report, changes nothing.
---

Collect existing shortcut comments into one ledger so a deferral can't quietly
become permanent. Do not add branded prefixes to code comments.

## Scan

Grep the repo for shortcut markers, skipping `node_modules`, `.git`, and build
output:

`grep -rnE '(#|//) ?(TODO|FIXME|HACK|XXX|debt|shortcut|temporary|naive|global lock)' .`

Each relevant hit is one ledger row.

## Output

One row per marker, grouped by file:

`<file>:<line>, <what was simplified>. ceiling: <the limit named>. upgrade: <the trigger to revisit>.`

Pull the ceiling and trigger straight from the comment when present. Want an
owner per row too? add `git blame -L<line>,<line>`.

Flag the rot risk: any shortcut comment that names no upgrade path or trigger
gets a `no-trigger` tag, those are the ones that silently rot.

End with `<N> markers, <M> with no trigger.` Nothing found: `No deferred shortcut debt. Clean ledger.`

## Boundaries

Reads and reports only, changes nothing. To persist it, ask and it writes the
ledger to a file (e.g. `PONYTAIL-DEBT.md`). One-shot. "stop ponytail-debt" or
"normal mode" to revert.
