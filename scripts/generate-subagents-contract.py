#!/usr/bin/env python3
"""Extract #305 from pinned Git blobs and render declarations; --check never writes.

Usage: python3 scripts/generate-subagents-contract.py ~/projects/codex [--check]
Requires Python 3, Git, and the existing offline/locked code-mode Rust renderer.
"""
import argparse
import copy
import hashlib
import json
import math
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parent.parent
REVISION = "25af12f7e61572b0bc18ddb1008be543b91519b0"
PREFIX = "codex-rs/core/src/"
SOURCES = [PREFIX + path for path in (
    "tools/handlers/multi_agents_spec.rs", "tools/handlers/multi_agents.rs",
    "tools/handlers/multi_agents_common.rs", "tools/handlers/multi_agents/spawn.rs",
    "tools/handlers/multi_agents/send_input.rs", "tools/handlers/multi_agents/wait.rs",
    "tools/handlers/multi_agents/close_agent.rs", "tools/handlers/multi_agents/resume_agent.rs",
    "session/multi_agents.rs", "agent/role.rs", "agent/builtins/explorer.toml",
    "config/mod.rs", "config/agent_roles.rs", "agent/control/spawn.rs",
    "tools/spec_plan.rs", "tools/parallel.rs",
)] + ["codex-rs/core/templates/collab/experimental_prompt.md", "codex-rs/tools/src/code_mode.rs", "codex-rs/code-mode-protocol/src/description.rs", "LICENSE", "NOTICE"]
NAMES = ["spawn_agent", "send_input", "wait_agent", "close_agent", "resume_agent"]
STRING = r'"(?:[^"\\]|\\.)*"'


def one(pattern, text):
    matches = re.findall(pattern, text, re.S)
    if len(matches) != 1:
        raise ValueError(f"Expected one match for {pattern}, got {len(matches)}")
    return matches[0]


def function(source, name):
    # Pinned top-level Rust functions close at column zero; this is not a Rust parser.
    return one(r'\bfn ' + name + r'\(.*?\n\}', source)


def constant(source, name):
    return json.loads(one(r'\bconst ' + name + r': &str =\s*(' + STRING + r');', source))


def primitives(source):
    return {name: dict(type=kind, description=json.loads(description))
            for name, kind, description in re.findall(
                r'"(\w+)"\.to_string\(\),\s*JsonSchema::(string|boolean|number)\(Some\(\s*('
                + STRING + r')\s*\.to_string\(\)', source)}


def object_schema(properties, required):
    return dict(type="object", properties=dict(sorted(properties.items())),
                required=required, additionalProperties=False)


def extract(sources):
    spec = sources[PREFIX + "tools/handlers/multi_agents_spec.rs"].decode()
    role = sources[PREFIX + "agent/role.rs"].decode()
    roles = {"default": json.loads(one(r'description: Some\((' + STRING + r')\.to_string\(\)\)', role))}
    for name in ("explorer", "worker"):
        roles[name] = one(r'"' + name + r'"\.to_string\(\),\s*AgentRoleConfig \{\s*description: Some\(r#"(.*?)"#', role)
    role_guidance = "Available roles:\n" + "\n".join(f"{name}: {{\n{value}\n}}" for name, value in roles.items())
    # Empty built-in explorer config means no locked-setting note to append.
    if sources[PREFIX + "agent/builtins/explorer.toml"].strip():
        raise ValueError("Explorer configuration now needs role-note evaluation")
    namespace = dict(name=constant(spec, "MULTI_AGENT_V1_NAMESPACE"),
                     description=constant(spec, "MULTI_AGENT_V1_NAMESPACE_DESCRIPTION"))
    spawn = function(spec, "spawn_agent_tool_description")
    templates = re.findall(r'r#"(.*?)"#', spawn, re.S)
    values = dict(agent_role_guidance=one(r'return (' + STRING + r')\.to_string\(\);', function(spec, "spawn_agent_models_description")),
                  inherited_model_guidance=constant(spec, "SPAWN_AGENT_INHERITED_MODEL_GUIDANCE"),
                  return_value_description=json.loads(one(r'let return_value_description =\s*(' + STRING + r');', function(spec, "create_spawn_agent_tool_v1"))),
                  agent_role_usage_hint=json.loads(one(r'\{\s*(' + STRING + r')\s*\}', spawn)))
    values["agent_role_guidance"] = json.loads(values["agent_role_guidance"])
    values["tool_description"] = templates[0].format_map(values)
    spawn_description = templates[-1].format_map(values)

    def output(name, previous=None):
        body = one(r'json!\((.*)\)\s*\}', function(spec, name))
        if "agent_status_output_schema()" in body:
            body = body.replace("agent_status_output_schema()", json.dumps(output("agent_status_output_schema")))
        if previous is not None:
            body = body.replace("previous_status_description", json.dumps(previous))
        return json.loads(body)

    common = sources[PREFIX + "tools/handlers/multi_agents_common.rs"].decode()
    config = sources[PREFIX + "config/mod.rs"].decode()

    def integer(name):
        value = one(r'\bconst ' + name + r': i64 =\s*([^;]+);', common + config).strip()
        return math.prod(int(part.replace("_", "")) for part in value.split("*")) if re.fullmatch(r'[\d_ *]+', value) else integer(value)

    native = {}
    for name in NAMES:
        constructor = function(spec, "create_" + name + ("_tool" if name == "resume_agent" else "_tool_v1"))
        fields_source = function(spec, "spawn_agent_common_properties_v1") if name == "spawn_agent" else constructor
        if name == "wait_agent":
            fields_source = function(spec, "wait_agent_tool_parameters_v1")
        fields = primitives(fields_source)
        if name == "spawn_agent":
            fields["agent_type"] = dict(type="string", description=constant(spec, "SPAWN_AGENT_TYPE_OVERRIDE_DESCRIPTION_V1") + "\n" + role_guidance)
            for field in ("model", "service_tier"):
                fields[field] = dict(type="string", description=constant(spec, "SPAWN_AGENT_" + field.upper() + "_OVERRIDE_DESCRIPTION"))
        if name in ("spawn_agent", "send_input"):
            items = function(spec, "create_collab_input_items_schema")
            fields["items"] = dict(type="array", items={k: v for k, v in object_schema(primitives(items), []).items() if k != "required"},
                                   description=json.loads(one(r'Some\(\s*(' + STRING + r')\s*\.to_string\(\),\s*\)\)\s*\}', items)))
        if name == "wait_agent":
            fields["targets"] = dict(type="array", items=dict(type="string"), description=json.loads(one(r'Some\(\s*(' + STRING + r')\s*\.to_string\(\),', fields_source)))
            timeout = json.loads(one(r'format!\(\s*(' + STRING + r')', fields_source))
            fields["timeout_ms"] = dict(type="number", description=timeout.format(*(integer(n + "_WAIT_TIMEOUT_MS") for n in ("DEFAULT", "MIN", "MAX"))))
        required = {"spawn_agent": [], "send_input": ["target"], "wait_agent": ["targets"], "close_agent": ["target"], "resume_agent": ["id"]}[name]
        parameters = object_schema(fields, required)
        if name == "spawn_agent":
            del parameters["required"]
        output_name = dict(spawn_agent="spawn_agent_output_schema_v1", send_input="send_input_output_schema", wait_agent="wait_output_schema_v1", close_agent="agent_previous_status_output_schema", resume_agent="resume_agent_output_schema")[name]
        previous = json.loads(one(r'agent_previous_status_output_schema\(\s*(' + STRING + r'),', constructor)) if name == "close_agent" else None
        native[name] = dict(name=name, description=spawn_description if name == "spawn_agent" else json.loads(one(r'description:\s*(' + STRING + r')', constructor)), parameters=parameters, output_schema=output(output_name, previous))
    supported = copy.deepcopy(native)
    edits = []

    def edit(path, before, after, reason):
        edits.append(dict(path=path, before=before, after=after, reason=reason))

    for name in ("spawn_agent", "send_input"):
        parameters = supported[name]["parameters"]
        edit(f"tools.{name}.parameters.properties.items", parameters["properties"].pop("items"), None, "Pi supports plain-text input, not Responses input items.")
        field = parameters["properties"]["message"]
        replacement = "Initial plain-text task for the new agent." if name == "spawn_agent" else "Plain-text message to send to the agent."
        edit(f"tools.{name}.parameters.properties.message.description", field["description"], replacement, "Remove instructions for unsupported items and legacy wording.")
        field["description"] = replacement
        required = ["message"] if name == "spawn_agent" else ["target", "message"]
        edit(f"tools.{name}.parameters.required", parameters.get("required"), required, "Plain-text message is required when items are unsupported.")
        parameters["required"] = required
    edit("tools.spawn_agent.parameters.properties.service_tier", supported["spawn_agent"]["parameters"]["properties"].pop("service_tier"), None, "Pi has no supported per-subagent service-tier override.")
    statuses = output("agent_status_output_schema")["oneOf"]
    return dict(namespace=namespace, roles=roles, tools=supported), native, edits, statuses[0]["enum"] + ["completed", "errored"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("checkout", type=Path)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    tag_revision = subprocess.check_output(["git", "-C", str(args.checkout), "rev-parse", "rust-v0.145.0^{}"], text=True).strip()
    if tag_revision != REVISION:
        raise ValueError("rust-v0.145.0 does not resolve to the pinned revision")
    sources = {path: subprocess.check_output(["git", "-C", str(args.checkout), "show", f"{REVISION}:{path}"]) for path in SOURCES}
    manifest = dict(repository="https://github.com/openai/codex", revision=REVISION, tag="rust-v0.145.0",
                    sha256={path: hashlib.sha256(data).hexdigest() for path, data in sources.items()})
    manifest_path = ROOT / "docs/code-mode-contract/subagents-source-manifest.json"
    if manifest_path.exists() and json.loads(manifest_path.read_text()) != manifest:
        raise ValueError("Pinned source manifest mismatch")
    renderer_source = ROOT / "packages/ext/codex-adapter/vendor/code-mode/crates/code-mode-protocol/src/description.rs"
    if renderer_source.read_bytes() != sources["codex-rs/code-mode-protocol/src/description.rs"]:
        raise ValueError("Declaration renderer differs from the pinned upstream source")
    contract, native, edits, statuses = extract(sources)
    definitions = [dict(name=contract["namespace"]["name"] + "__" + name,
                        tool_name=dict(name=name, namespace=contract["namespace"]["name"]),
                        description=tool["description"], kind="function", input_schema=tool["parameters"], output_schema=tool["output_schema"])
                   for name, tool in contract["tools"].items()]
    def render(tools):
        return json.loads(subprocess.check_output(["cargo", "run", "--quiet", "--locked", "--offline", "--manifest-path", str(ROOT / "scripts/code-mode-contract/Cargo.toml")], input=json.dumps(tools), text=True))

    # Native collect_code_mode_exec_prompt_tool_definitions leaves prose unprefixed;
    # collect_code_mode_tool_definitions prepends namespace guidance before augmentation.
    rendered = render(definitions)
    namespace_description = contract["namespace"]["description"].strip()
    runtime_definitions = [dict(tool, description=f"{namespace_description}\n\n{tool['description']}")
                           for tool in definitions]
    runtime = render(runtime_definitions)
    result = dict(revision=REVISION, source_paths=SOURCES, agent_statuses=statuses,
                  configuration=dict(version="V1", available_models=[], user_defined_roles={}, expose_agent_type=True, hide_agent_type_model_reasoning=False, usage_hint_text=None),
                  edits=edits, native_tools=native, contract=contract,
                  nested_tools=[dict(**tool, section=section, runtime_description=description) for tool, section, description in zip(definitions, rendered["sections"], runtime["descriptions"], strict=True)])
    result["sha256"] = {key: hashlib.sha256(json.dumps(result[key], ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
                        for key in ("native_tools", "contract", "nested_tools")}
    for path, value in ((manifest_path, manifest), (ROOT / "docs/code-mode-contract/subagents-supported.json", result)):
        data = json.dumps(value, indent=2, ensure_ascii=False) + "\n"
        # Compare parsed JSON: the repository formatter controls JSON whitespace.
        if args.check:
            if not path.exists() or json.loads(path.read_text()) != value:
                raise ValueError(f"Generated artifact differs: {path}")
        else:
            path.write_text(data)
    print("Subagent contract " + ("verified" if args.check else "generated"))


if __name__ == "__main__":
    main()
