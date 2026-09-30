# Native Code Mode contracts

Parent and SDK child sessions use Pi 0.99.1 native `codemode`, registry discovery
and one-shot execution. Parallel calls and resumable shell sessions remain;
JavaScript cells do not yield or resume. There is no external host installation,
legacy runtime selection or fallback. The [native adapter contract](native-parent.md)
is authoritative for invocation, values, permissions, ownership and presentation.
The [ADRs](../adr/0001-codex-code-mode-scope.md) retain the historical decisions and
explicitly record this approved tradeoff. The #365 model/route amendment remains.

## Owned-tool provenance and reproduction

The five owned capabilities retain useful Codex source definitions from
`rust-v0.145.0` / `25af12f7e61572b0bc18ddb1008be543b91519b0`.
[Source manifest](source-manifest.json) pins only the retained tool definitions,
patch grammar, web text and licenses. [Native text](native-text.json) contains
upstream patch grammar and complete web help as audit inputs, not runtime helper
advertising. The generated source projections preserve supported fields and omit
unsupported sandbox profiles, hosted web operations and image resize controls.
They are provenance, not a second runtime ABI: native registration owns argument
preparation and result schemas (notably patch mutation lists and `{input}` calls).
Only the supported full web description is consumed directly at registration.

Reproduce from the repository root with Python 3 and Git, using a local Codex
checkout containing the pin and a fresh evidence directory:

```sh
python3 scripts/extract-code-mode-contract.py ~/projects/codex /tmp/owned-tool-contract-evidence
cmp docs/code-mode-contract/source-manifest.json /tmp/owned-tool-contract-evidence/manifest.json
cmp docs/code-mode-contract/native-text.json /tmp/owned-tool-contract-evidence/native-text.json
python3 scripts/generate-code-mode-contract.py /tmp/owned-tool-contract-evidence /tmp/owned-tool-contracts.json
cmp packages/ext/codex-adapter/owned-tool-contracts.generated.json /tmp/owned-tool-contracts.json
```

Adjust the checkout/output paths for your machine. Extraction reads pinned Git
objects, not dirty checkout files; generation verifies source hashes and audit
text. No Rust protocol builder, V8 runtime or host vendor is needed. OpenAI's
Apache-2.0 [license](../../packages/ext/codex-adapter/contracts/LICENSE) and
[notice](../../packages/ext/codex-adapter/contracts/NOTICE) cover the retained text.
The concrete implementations, eight bundled executables and their separate
licenses/provenance remain in [UPSTREAM.md](../../packages/ext/codex-adapter/UPSTREAM.md).
Direct V2 collaboration keeps its independent contract and generator.

## Historical evidence

The [V8 baseline](historical-baseline.md), [activation](activation.md),
[runtime](runtime.md) and [cutover](cutover.md) records describe retired host behavior.
Their old smoke/build/install/generation commands are historical only.
The native [route smoke](../../scripts/code-mode-route-smoke.ts) uses codemode,
parallel calls and shell polling, not cell resumption. Live provider/arm64 release
validation remains separate; offline passes do not assert live route acceptance.
