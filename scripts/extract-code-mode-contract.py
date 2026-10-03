#!/usr/bin/env python3
"""Extract pinned owned-tool source evidence without reading checkout contents."""

import argparse
import hashlib
import json
from pathlib import Path
import subprocess

REVISION = "25af12f7e61572b0bc18ddb1008be543b91519b0"
# Full sources preserve computed schemas, descriptions, and decisive runtime paths.
SOURCES = (
    'LICENSE',
    'NOTICE',
    'codex-rs/core/src/tools/handlers/shell_spec.rs',
    'codex-rs/core/src/tools/handlers/apply_patch_spec.rs',
    'codex-rs/core/src/tools/handlers/apply_patch.lark',
    'codex-rs/core/src/tools/handlers/view_image_spec.rs',
    'codex-rs/ext/web-search/web_run_description.md',
    'codex-rs/codex-api/src/search.rs',
)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("checkout", type=Path, help="Local openai/codex Git checkout")
    parser.add_argument("output", type=Path, help="New directory for the evidence bundle")
    args = parser.parse_args()
    sources = {
        path: subprocess.run(
            ["git", "-C", str(args.checkout), "show", f"{REVISION}:{path}"],
            check=True, capture_output=True,
        ).stdout
        for path in SOURCES
    }

    native_text = {
        "revision": REVISION,
        "apply_patch_grammar": sources[
            "codex-rs/core/src/tools/handlers/apply_patch.lark"
        ].decode(),
        "web_description": sources[
            "codex-rs/ext/web-search/web_run_description.md"
        ].decode(),
    }
    manifest = {
        "repository": "https://github.com/openai/codex",
        "revision": REVISION,
        "sha256": {path: hashlib.sha256(data).hexdigest() for path, data in sources.items()},
    }
    args.output.mkdir(parents=True, exist_ok=False)
    for path, data in sources.items():
        target = args.output / "source" / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    for name, value in (("manifest.json", manifest), ("native-text.json", native_text)):
        (args.output / name).write_text(json.dumps(value, indent=2) + "\n")


if __name__ == "__main__":
    main()
