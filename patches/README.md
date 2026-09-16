# Pi-ai Code Mode wire parity (#323)

The adapter sets `wait.constrainedSampling: false`. Pi-ai 0.85.0 accepts this
setting but ignores it when resolving strictness. The patches make explicit false
opt out of strict sampling, leaving unset tools and grammar routing alone. They
also preserve tool-result content items on `openai-codex-responses` (both custom
and function calls); other Responses routes keep their existing serialization.

## Local validation

`package.json` pins the development pi-ai dependency at 0.85.0 and applies
`@earendil-works%2Fpi-ai@0.85.0.patch` with Bun. Run `bun install`, then:

```sh
env -u PI_PACKAGE_DIR bun --bun vitest run packages/ext/codex-adapter/code-mode-transport.test.ts
```

These tests intercept actual provider payloads before network access. They do
**not** prove that an installed Pi executable includes the patch.

## Runtime prerequisite

**Installing pi-bites alone does not fix the installed Pi host.** The installed
0.85.1 compiled Nix host embeds pi-ai; local Bun patches, `NODE_PATH`, and
`PI_PACKAGE_DIR` cannot replace its serializer. Both parity changes require a
patched host until an upstream Pi release includes them. No upstream release or
live-host verification is claimed here.

`pi-ai-codex-wire-source.patch` is the corresponding upstream TypeScript patch,
generated against the source maps published with pi-ai 0.85.0. In the source
checkout matching the host you intend to build:

```sh
git apply --check /path/to/pi-bites/patches/pi-ai-codex-wire-source.patch
git apply /path/to/pi-bites/patches/pi-ai-codex-wire-source.patch
```

Then rebuild Pi, including its pi-ai dependency, using that revision's build
instructions and install the resulting executable. A Nix derivation that merely
fetches prebuilt binaries must use a patched binary or build patched source;
adding a source patch without rebuilding does nothing. Do not substitute the
local 0.84.2 Pi checkout for matching 0.85.1 source without compatibility review.
Verify the rebuilt host's `before_provider_request` payload: `wait.strict` must
be false, and exec/wait outputs must retain ordered content arrays. The native
optional-field schema, grammar fallback, status text and output budgets remain
unchanged. This is wire parity, not a demonstrated fix for invalid wait IDs.

## Image and empty-output limits

Pi-ai's `ImageContent` supports MIME type and base64 data, not native image detail
hints. These patches preserve those bytes and the existing `detail: "auto"`;
they do not add an unsupported detail channel. Stock message transformation
replaces non-vision images with `(tool image omitted: model does not support
images)` before conversion; those placeholders retain their position. Codex
empty content is `[]`, a single text block is a one-item array, and empty text
blocks remain items. Unicode-surrogate sanitization is retained. Raw web markers,
whitespace, and UI rendering are otherwise untouched.

Remove both patches and the development pin when an upstream release contains
these behaviors, then rerun the payload tests against the new dependency and
installed host. Do not silently update past the version-keyed Bun patch.
