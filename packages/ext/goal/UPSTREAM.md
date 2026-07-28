# Upstream provenance

This directory is owned Pi-bites source vendored from [`pi-codex-goal`](https://github.com/fitchmultz/pi-codex-goal).

- Release: `v0.1.38`
- Commit: `707c754f19c814c455fcda7834f00f96f104922d`
- License: MIT; see [`LICENSE`](./LICENSE)

Imported runtime source, state, tools, command/UI behavior, prompts, the runtime harness/scenarios, and all upstream behavioral and SDK runtime test suites. Tests were adapted to Vitest and Pi-bites paths before runtime semantics were changed.

Upstream package metadata, its package-manifest and type-hygiene tests, publishing/release automation, generated artifacts, platform-smoke machinery, and standalone-package documentation are intentionally excluded. Pi-bites' own manifest, lint, and type checks cover the two omitted package-specific suites.
