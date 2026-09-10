---
name: pi-docs
description: Work effectively with the pi coding-agent harness, its SDK, extensions, themes, skills, TUI, providers, sessions, and packages. Use this skill whenever a task asks about pi itself, pi documentation, pi source code, pi extensions, or how to implement or debug behavior inside pi—even when the user does not explicitly say “use the pi-docs skill.”
disable-model-invocation: true
---

# Pi docs

Use the installed pi documentation as the source of truth. Prefer the current installation over memory or informal examples; APIs and paths can change between versions.

## Locate the installation

The pi documentation is normally installed at:

```text
/nix/store/1dp98a4mcph9wmb2jmc20h8qvjbnryys-pi-0.85.1/libexec/pi/README.md
/nix/store/1dp98a4mcph9wmb2jmc20h8qvjbnryys-pi-0.85.1/libexec/pi/docs/
/nix/store/1dp98a4mcph9wmb2jmc20h8qvjbnryys-pi-0.85.1/libexec/pi/examples/
```

If that exact store path is absent, locate the installed `pi` executable and resolve its adjacent `libexec/pi` directory. Confirm the version before relying on version-specific behavior.

## Read documentation

Read `docs/index.md` first for navigation, and `README.md` when you need package-level orientation. Then follow the relevant topic:

- CLI usage, commands, trust, and flags: `docs/usage.md`
- settings and resource paths: `docs/settings.md`
- extensions: `docs/extensions.md` and `examples/extensions/`
- themes: `docs/themes.md`
- skills: `docs/skills.md`
- prompt templates: `docs/prompt-templates.md`
- TUI components: `docs/tui.md`
- keybindings: `docs/keybindings.md`
- SDK integrations: `docs/sdk.md`
- custom providers: `docs/custom-provider.md`
- models: `docs/models.md`
- packages: `docs/packages.md`
- environment variables: `docs/environment-variables.md`
- sessions and tree navigation: `docs/sessions.md`
- embedding pi: `docs/sdk.md`
- RPC and structured output: `docs/rpc.md` and `docs/json.md`
- development and contribution: `docs/development.md`

Read Markdown files completely, not just matching excerpts, and follow their cross-references before implementing. Use `docs/docs.json` when the navigation or canonical path is unclear. For source behavior, search the pi installation and inspect the decisive call paths; examples illustrate usage but do not override the API documentation. For broad documentation or source exploration, delegate read-only research to an explore agent when available, with a concrete question and scope.

## Implementation workflow

1. Identify whether the request concerns the CLI, extension lifecycle, SDK, TUI, sessions, providers/models, configuration, or packaging.
2. Read `README.md`, the relevant topic document, and every linked document needed for the proposed path.
3. Inspect nearby examples and the installed source when behavior or lifecycle details are ambiguous.
4. Trace the affected flow end to end, including callers, replacement/reload paths, and error handling.
5. Make the smallest change at the shared seam. Reuse existing pi APIs and repository helpers before adding abstractions or dependencies.
6. Verify with the narrowest runnable check, then run the repository’s required validation commands.

Completion criterion: the implementation or answer is grounded in the installed pi version, all relevant documentation links have been followed, and the requested behavior has a reproducible verification.

## Resource and trust details

Check both global resources under `~/.pi/agent/` and project resources under `.pi/` when investigating discovery. Also check `.agents/skills` and `~/.agents/skills` for skills. Project resources can depend on project trust; consult `docs/settings.md` and `docs/usage.md` rather than assuming they load. `/reload` reloads resources, and explicit CLI paths such as `-e`, `--skill`, `--prompt-template`, and `--theme` can isolate a reproduction.

## Extension lifecycle safety

Treat extension `ctx` as ephemeral. Do not dereference a captured `ctx` from deferred callbacks, promise continuations, or timers: session replacement or reload can make its getters throw. Snapshot stable dependencies while `ctx` is active, reacquire context from lifecycle events, or use replacement APIs’ `withSession` context. Regression tests should model stale context with throwing getters when this behavior matters.

## Reporting

For documentation questions, cite the exact file and section used. For code changes, name modified paths, summarize the seam changed, and state the validation run. Distinguish documented behavior from observations inferred from source or examples.
