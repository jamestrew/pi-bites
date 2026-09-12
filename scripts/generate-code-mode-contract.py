#!/usr/bin/env python3
"""Generate the supported #300 surface from #295's hash-verified evidence bundle."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parent.parent


def object_schema(properties, required=()):
    return dict(type="object", properties=properties, required=list(required), additionalProperties=False)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("evidence", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    manifest = json.loads((ROOT / "docs/code-mode-contract/source-manifest.json").read_text())

    def source(path):
        data = (args.evidence / "source" / path).read_bytes()
        if hashlib.sha256(data).hexdigest() != manifest["sha256"][path]:
            raise ValueError(f"Pinned source hash mismatch: {path}")
        return data.decode()

    prefix = "codex-rs/core/src/tools/"
    shell = source(prefix + "handlers/shell_spec.rs")
    wait = source(prefix + "code_mode/wait_spec.rs").split("#[cfg(test)]")[0]
    view = source(prefix + "handlers/view_image_spec.rs")
    search = source("codex-rs/codex-api/src/search.rs")
    native = json.loads((args.evidence / "native-text.json").read_text())
    if native != json.loads((ROOT / "docs/code-mode-contract/native-text.json").read_text()):
        raise ValueError("Native text does not match retained baseline")

    def primitive_fields(text):
        pattern = r'"(\w+)"\.to_string\(\),\s*JsonSchema::(string|number|boolean)\(Some\(\s*"([^"\\]*(?:\\.[^"\\]*)*)"\s*\.to_string\(\)'
        return {name: dict(type=kind, description=json.loads('"' + desc + '"'))
                for name, kind, desc in re.findall(pattern, text)}

    def output_schema(text, function):
        match = re.search(r'fn ' + function + r'\(\) -> Value \{\s*json!\((.*?)\)\s*\}', text, re.S)
        return json.loads(match[1])

    def definition(name, description, schema=None, output=None, kind="function"):
        return dict(name=name, tool_name=dict(name=name, namespace=None), description=description,
                    kind=kind, input_schema=schema, output_schema=output)

    exec_part = shell.split("pub fn create_write_stdin_tool")[0]
    exec_fields = primitive_fields(exec_part)
    exec_fields["yield_time_ms"] = dict(type="number", description=re.search(
        r'} else \{\s*"([^"]+)"', exec_part)[1])
    exec_fields["shell"]["description"] = exec_fields["shell"]["description"].replace("the user's default shell", "Pi's configured shell")
    exec_fields = {key: exec_fields[key] for key in ("cmd", "workdir", "shell", "tty", "login", "yield_time_ms", "max_output_tokens")}
    stdin_part = shell.split("pub fn create_write_stdin_tool")[1].split("pub fn create_shell_command_tool")[0]
    shell_output = output_schema(shell, "unified_exec_output_schema")
    tools = [
        definition("exec_command", re.search(r'"(Runs a command in a PTY,[^"\\]+)"', exec_part)[1], object_schema(exec_fields, ["cmd"]), shell_output),
        definition("write_stdin", re.search(r'"(Writes characters[^"\\]+)"', stdin_part)[1], object_schema(primitive_fields(stdin_part), ["session_id"]), shell_output),
    ]
    patch = source(prefix + "handlers/apply_patch_spec.rs")
    tools.append(definition("apply_patch", re.search(r'"(The `apply_patch` tool[^"\\]+)"', patch)[1], kind="freeform"))

    def search_schema(struct):
        body = re.search(r'pub struct ' + struct + r' \{(.*?)\n\}', search, re.S)[1]
        properties, required = {}, []
        for description, name, rust_type in re.findall(r'/// ([^\n]+)\n\s*(?:#\[[^\n]+\]\n\s*)?pub (\w+): ([^\n]+),', body):
            optional = rust_type.startswith("Option<")
            typ = rust_type[7:-1] if optional else rust_type
            if typ == "String": value = dict(type="string")
            elif typ == "u64": value = dict(type="integer", minimum=0)
            elif typ == "Vec<String>": value = dict(type="array", items=dict(type="string"), maxItems=20)
            elif typ == "SearchResponseLength": value = dict(type="string", enum=["short", "medium", "long"])
            elif typ.startswith("Vec<"):
                if name not in ["search_query", "image_query", "open", "click", "find"]: continue
                value = dict(type="array", items=search_schema(typ[4:-1]), minItems=1, maxItems=4 if name.endswith("query") else 10)
            else: raise ValueError(typ)
            properties[name] = dict(**value, description=description)
            if not optional: required.append(name)
        return object_schema(properties, required)

    web = native["web_description"]
    web = "\n".join(line for line in web.split("\n") if not any(line.startswith('* `' + name + '`') for name in ["screenshot", "finance", "weather", "sports", "time"]))
    web = web.replace(', "finance":[{"ticker":"BTC","type":"crypto","market":""}]', '')
    web = web.replace("`web.run`", "`tools.web_run`").replace("web.run", "tools.web_run")
    tools.append(definition("web_run", web, search_schema("SearchCommands"), dict(type="string")))
    image_output = output_schema(view, "view_image_output_schema")
    image_output["properties"]["detail"] = dict(type="string", enum=["original"], description="Image detail hint returned by view_image. Returns `original` when original resolution is preserved.")
    tools.append(definition("view_image", re.search(r'description: "([^"]+)"', view)[1], object_schema({"path": primitive_fields(view)["path"]}, ["path"]), image_output))
    generated = subprocess.run(["cargo", "run", "--quiet", "--locked", "--offline", "--manifest-path", str(ROOT / "scripts/code-mode-contract/Cargo.toml")], input=json.dumps(tools), stdout=subprocess.PIPE, text=True, check=True)
    rendered = json.loads(generated.stdout)
    base = "\n".join(line for line in rendered["deferred_base"].split("\n") if not line.startswith(("- `audio(", "- `generatedImage(")))
    base = base.replace(' Tool names are exposed as normalized JavaScript identifiers, for example `await tools.mcp__ologs__get_profile(...)`.', '')
    base = base.replace('immediately injects an extra `custom_tool_call_output` for the current `exec` call.', 'queues output for the next `exec`/`wait` observation; Pi UI updates are not immediate model messages.')
    result = dict(revision=manifest["revision"], exec_base=base, exec_grammar=native["exec_grammar"], wait_description=native["wait_description"], wait_schema=object_schema(primitive_fields(wait), ["cell_id"]), tools=[dict(**tool, section=section, runtime_description=description) for tool, section, description in zip(tools, rendered["sections"], rendered["descriptions"], strict=True)])
    args.output.write_text(json.dumps(result, indent=2) + "\n")


if __name__ == "__main__":
    main()
