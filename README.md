# pi explore subagent

A minimal pi extension that adds one custom tool: `explore`.

The tool runs a separate `pi` subprocess in read-only mode with isolated context:

- `read`
- `grep`
- `find`
- `ls`

That makes it useful for reconnaissance and codebase exploration without cluttering the main agent context.

## Local development

Run pi with the extension directly from this repo:

```bash
pi -e ./src/index.ts
```

## Install via symlink

This keeps the source in this repo, but makes pi auto-discover it.

```bash
mkdir -p ~/.pi/agent/extensions
ln -sfn "$PWD/src/index.ts" ~/.pi/agent/extensions/explore-subagent.ts
```

Then start pi normally and it should auto-load.

## Reload during development

If you use the symlinked install, edit `src/index.ts` here and then run:

```text
/reload
```

inside pi.

## What the tool does

The `explore` tool:

1. writes an exploration system prompt to a temp file
2. spawns a child `pi` process in JSON mode
3. disables extension/prompt/skill/theme discovery in the child process
4. limits the child process to read-only tools
5. streams progress back to the parent session

## Child pi invocation

Roughly equivalent to:

```bash
pi \
  --mode json \
  -p \
  --no-session \
  --no-extensions \
  --no-skills \
  --no-prompt-templates \
  --no-themes \
  --tools read,grep,find,ls \
  --append-system-prompt <tempfile> \
  "<task>"
```

## Next ideas

- better custom result rendering
- optional `bash` support for richer exploration
- a slash command that queues an explore run
- configurable default model
- project-specific exploration prompt tweaks
