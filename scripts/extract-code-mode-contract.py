#!/usr/bin/env python3
"""Extract issue #295's pinned source evidence without reading checkout contents."""

import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess

REVISION = "25af12f7e61572b0bc18ddb1008be543b91519b0"
# Full sources preserve computed schemas, descriptions, and decisive runtime paths.
SOURCES = (
    "LICENSE",
    "NOTICE",
    "codex-rs/code-mode-protocol/src/description.rs",
    "codex-rs/code-mode-protocol/src/runtime.rs",
    "codex-rs/code-mode-protocol/src/response.rs",
    "codex-rs/code-mode-protocol/src/host/codec.rs",
    "codex-rs/code-mode-protocol/src/host/message.rs",
    "codex-rs/code-mode-protocol/src/host/payload.rs",
    "codex-rs/code-mode/src/service.rs",
    "codex-rs/code-mode/src/cell_actor/mod.rs",
    "codex-rs/code-mode/src/cell_actor/callbacks.rs",
    "codex-rs/code-mode/src/runtime/globals.rs",
    "codex-rs/code-mode/src/runtime/value.rs",
    "codex-rs/code-mode-host/src/peer.rs",
    "codex-rs/core/src/tools/code_mode/execute_spec.rs",
    "codex-rs/core/src/tools/code_mode/wait_spec.rs",
    "codex-rs/core/src/tools/code_mode/execute_handler.rs",
    "codex-rs/core/src/tools/code_mode/wait_handler.rs",
    "codex-rs/core/src/tools/code_mode/mod.rs",
    "codex-rs/core/src/tools/handlers/shell_spec.rs",
    "codex-rs/core/src/tools/handlers/unified_exec.rs",
    "codex-rs/core/src/unified_exec/mod.rs",
    "codex-rs/core/src/unified_exec/process_manager.rs",
    "codex-rs/core/src/tools/handlers/apply_patch_spec.rs",
    "codex-rs/core/src/tools/handlers/apply_patch.lark",
    "codex-rs/core/src/tools/handlers/view_image_spec.rs",
    "codex-rs/core/src/tools/handlers/view_image.rs",
    "codex-rs/core/src/tools/context.rs",
    "codex-rs/tools/src/code_mode.rs",
    "codex-rs/tools/src/tool_output.rs",
    "codex-rs/ext/web-search/src/tool.rs",
    "codex-rs/ext/web-search/src/schema.rs",
    "codex-rs/ext/web-search/src/output.rs",
    "codex-rs/ext/web-search/web_run_description.md",
    "codex-rs/codex-api/src/search.rs",
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

    def raw_constant(path, name):
        source = sources[path].decode()
        matches = re.findall(r"\bconst " + name + r': &str = r#"(.*?)"#;', source, re.S)
        if len(matches) != 1:
            raise ValueError(f"Expected exactly one {name} in {path}")
        return matches[0]

    # These are native audit inputs, NOT the capability-filtered Pi tool prompt.
    description = "codex-rs/code-mode-protocol/src/description.rs"
    native_text = {
        "revision": REVISION,
        "exec_description_template": raw_constant(description, "EXEC_DESCRIPTION_TEMPLATE"),
        "wait_description": "Waits on a yielded `exec` cell and returns new output or completion.\n"
        + raw_constant(description, "WAIT_DESCRIPTION_TEMPLATE").strip(),
        "exec_grammar": raw_constant(
            "codex-rs/core/src/tools/code_mode/execute_spec.rs", "CODE_MODE_FREEFORM_GRAMMAR"
        ),
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
