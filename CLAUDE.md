## Pi documentation

This repo is a collection of extension for the coding agent pi. When you need information about pi itself, its SDK, extensions, themes, skills, or TUI APIs, use the installed pi documentation instead of guessing.

- Main documentation: `node_modules/@earendil-works/pi-coding-agent/README.md`
- Additional docs: `node_modules/@earendil-works/pi-coding-agent/docs`
- Examples: `node_modules/@earendil-works/pi-coding-agent/examples`

Resolve `docs/...` paths under the Additional docs directory, not the current repo. Resolve `examples/...` paths under the Examples directory.

Topic map:

- Extensions: `docs/extensions.md`, `examples/extensions/`
- Themes: `docs/themes.md`
- Skills: `docs/skills.md`
- Prompt templates: `docs/prompt-templates.md`
- TUI components: `docs/tui.md`
- Keybindings: `docs/keybindings.md`
- SDK integrations: `docs/sdk.md`
- Custom providers: `docs/custom-provider.md`
- Adding models: `docs/models.md`
- Pi packages: `docs/packages.md`

When working on pi topics, read the relevant docs and examples before implementing. Follow cross-references in the markdown files when they point to related docs.

## Git

I'm using `jj` backed by `git`. Inside `jj` workspaces, there's no git access.
When using `gh` CLI, will need to pass the repo name `jamestrew/pi-bites`.

## Validation

Run `bun check` before finalizing code changes.
