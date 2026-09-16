# Releases

pi-bites releases are Git tags named `vMAJOR.MINOR.PATCH` with corresponding
GitHub Releases. `package.json` at the tagged commit must have the same version
without `v`. No npm publication is required.

## Compatibility

Starting at **1.0.0**:

- **Major**: breaking package, extension, configuration, or host-hook changes,
  including an increase in the minimum supported Pi host version.
- **Minor**: backwards-compatible features.
- **Patch**: backwards-compatible fixes.

The promise covers documented installation paths, extension interfaces,
configuration, and host hooks, not undocumented internal implementation details.
Release notes should identify breaking changes, migrations, and host requirements.
A release does not promise compatibility with every future Pi host version.

Published tags must never be moved, deleted, or reused for different contents.
Correct mistakes with a new release. Do not use moving major/minor tags such as
`v1` or `v1.2` as substitutes for exact release tags.

Before the first release, enable **Settings → General → Releases → Enable release
immutability** on GitHub so published tags are protected server-side as well.
See [GitHub’s instructions](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/establish-provenance-and-integrity/prevent-release-changes).
The script does not change repository settings.

## Maintainer procedure

Prerequisites: Bun, Git, jj, authenticated `gh`, and push/release access to
`jamestrew/pi-bites`. Run from this repository with `origin` pointing to that
repository. Commit and push the changes you want to release first, then leave
an empty, single-parent jj working copy on top of the default-branch tip.

The first release is a deliberate maintainer step **after this mechanism and
policy are accepted and merged**. The manifest is prepared at `1.0.0`; this
document does not imply the tag already exists:

```sh
bun run release v1.0.0
```

For subsequent releases, choose one:

```sh
bun run release --patch  # 1.0.0 → 1.0.1
bun run release --minor  # 1.0.0 → 1.1.0
bun run release --major  # 1.0.0 → 2.0.0
```

Increment mode runs `bun check`, asks for confirmation, updates `package.json`,
creates a conventional jj release commit, and pushes that commit to the default
branch. It then pushes the exact tag and creates the GitHub Release with generated
notes. Git pushes use explicit commit/ref arguments rather than relying on a
branch checkout; no force pushes are used. Local bookmarks are not moved.
Review the generated release notes on GitHub and add compatibility/migration
information where needed.

Explicit-tag mode does not edit or commit anything: the tag must match the
committed manifest, and the release commit must already be on the remote default
branch's history. Both modes reject dirty/merged working copies and changes made
by validation. Confirmation requires an interactive terminal. Do not edit or
switch the working copy while a release is running.

### Interrupted releases

The script stops on errors and leaves completed steps intact; it never deletes
or force-updates a tag to undo a partially completed release.

- If the version commit was created but its push failed, resolve the push failure
  and publish that commit to the default branch. The script prints the commit and
  destination. Do not create another increment just to retry.
- If the tag was pushed but GitHub Release creation failed, rerun with the
  **explicit tag**, e.g. `bun run release v1.1.0`, from an empty working copy on top
  of that release commit. Matching existing tags are reused; conflicting tags
  are rejected.
- If the GitHub Release already exists, `gh release create` reports an error
  rather than replacing it. Check the existing release; no retry is necessary
  when publication already succeeded.

There is no automatic release schedule. Release when a consumer needs a change;
CI-based publishing can be added if local releases become a maintenance burden.

## Pinning a consumer

After the desired release exists, install its exact tag:

```sh
pi install git:github.com/jamestrew/pi-bites@v1.0.0
```

This saves the package source in `~/.pi/agent/settings.json`. Use `-l` for
project-local `.pi/settings.json`. The equivalent package configuration is:

```json
{
  "packages": ["git:github.com/jamestrew/pi-bites@v1.0.0"]
}
```

To select a newer published release, run `pi install` with its exact tag, for
example `pi install git:github.com/jamestrew/pi-bites@v1.0.1`. Pinned refs do not
advance automatically to newer tags. `pi update --extensions` reconciles packages
to their configured refs; `pi update` alone updates Pi itself, not packages.
Orbit can therefore update its operator's pin independently of Orbit deployments.
