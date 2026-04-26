# pi explore subagent

A minimal pi extension that adds one custom tool: `explore`.

## Local development

Run pi with the extension directly from this repo:

```bash
pi -e ./src/index.ts
```

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
  --no-prompt-templates \
  --no-themes \
  --tools read,grep,find,ls \
  --append-system-prompt <tempfile> \
  "<prompt>"
```

## TODO

- [x] optional `bash` support for richer exploration
- [x] include skills
- [ ] configurable default model
- [ ] project-specific exploration prompt tweaks
- [x] better ui
      mid-explore:

  ```
  Explore(Explore repo structure demo)
  ⎿  Read(README.md)
     Read(package.json)
     Bash(ls -la /home/jt/projects/pi-explore/src/)
     Running…
     +3 more tool uses (ctrl+o to expand)
  ```

  shows the last 3 tool calls

  when it finishes

  ```
  ● Explore(Explore repo structure demo)
    ⎿  Done (6 tool uses · 29.1k tokens · 10s)
    (ctrl+o to expand)
  ```
