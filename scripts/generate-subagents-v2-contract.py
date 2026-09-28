#!/usr/bin/env python3
"""Extract #346's six direct-tool declarations from immutable Codex Git blobs.

Usage: python3 scripts/generate-subagents-v2-contract.py ~/projects/codex [--check]
Requires only Python 3 and Git. --check never writes; checkout HEAD is irrelevant.
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
REVISION = "1a89aec960cd92e2c59ce49b7f3c3347a915e4a9"
PREFIX = "codex-rs/core/src/"
NAMES = ["spawn_agent", "send_message", "followup_task", "wait_agent", "interrupt_agent", "list_agents"]
SOURCES = [PREFIX + path for path in (
    "tools/handlers/multi_agents_spec.rs", "tools/handlers/multi_agents_common.rs",
    "tools/handlers/multi_agents_v2/spawn.rs", "tools/handlers/multi_agents_v2/message_tool.rs",
    "tools/handlers/multi_agents_v2/send_message.rs", "tools/handlers/multi_agents_v2/followup_task.rs",
    "tools/handlers/multi_agents_v2/wait.rs", "tools/handlers/multi_agents_v2/interrupt_agent.rs",
    "tools/handlers/multi_agents_v2/list_agents.rs", "tools/spec_plan.rs", "config/mod.rs",
    "agent/role.rs", "agent/child_config.rs", "agent/control/api.rs", "agent/control/interrupt.rs",
    "agent/control.rs", "agent/control/target.rs", "agent/agent_resolver.rs",
    "session/input_queue.rs", "thread_rollout_truncation.rs",
)] + ["codex-rs/core/assets/agent/builtins/explorer.toml", "codex-rs/protocol/src/agent_path.rs",
     "codex-rs/tools/src/json_schema/types.rs", "LICENSE", "NOTICE"]
STRING = r'"(?:[^"\\]|\\.)*"'


def one(pattern, source):
    matches = re.findall(pattern, source, re.S)
    if len(matches) != 1:
        raise ValueError(f"Expected one match for {pattern}, got {len(matches)}")
    return matches[0]


def function(source, name):
    # These pinned top-level Rust functions close at column zero; not a Rust parser.
    return one(r'\bfn ' + name + r'\(.*?\n\}', source)


def primitives(source):
    return {name: dict(type=kind, description=json.loads(description))
            for name, kind, description in re.findall(
                r'"(\w+)"\.to_string\(\),\s*JsonSchema::(string|number)\(Some\(\s*('
                + STRING + r')\s*\.to_string\(\)', source)}


def extract(sources):
    spec = sources[PREFIX + "tools/handlers/multi_agents_spec.rs"].decode()
    role = sources[PREFIX + "agent/role.rs"].decode()
    roles = {"default": json.loads(one(r'description: Some\((' + STRING + r')\.to_string\(\)\)', role))}
    for name in ("explorer", "worker"):
        roles[name] = one(r'"' + name + r'"\.to_string\(\),\s*AgentRoleConfig \{\s*description: Some\(r#"(.*?)"#', role)
    if sources["codex-rs/core/assets/agent/builtins/explorer.toml"].strip():
        raise ValueError("Explorer role now requires locked-setting note evaluation")
    role_guidance = "Available roles:\n" + "\n".join(f"{name}: {{\n{value}\n}}" for name, value in roles.items())
    spawn_templates = re.findall(r'r#"(.*?)"#', function(spec, "spawn_agent_tool_description_v2"), re.S)
    spawn_description = spawn_templates[1].format_map(dict(
        agent_role_guidance=json.loads(one(r'return (' + STRING + r')\.to_string\(\);', function(spec, "spawn_agent_models_description"))),
        inherited_model_guidance=""))

    def output(name, previous=None):
        body = function(spec, name)
        if name == "spawn_agent_output_schema_v2":
            body = one(r'return json!\((.*?)\);', body)
        else:
            body = one(r'json!\((.*)\)\s*\}', body)
        if "agent_status_output_schema()" in body:
            body = body.replace("agent_status_output_schema()", json.dumps(output("agent_status_output_schema")))
        if previous is not None:
            body = body.replace("previous_status_description", json.dumps(previous))
        return json.loads(body)

    config = sources[PREFIX + "config/mod.rs"].decode()
    timeouts = {name.lower(): math.prod(int(p.replace("_", "")) for p in one(
        r'const DEFAULT_MULTI_AGENT_V2_' + name + r'_WAIT_TIMEOUT_MS: i64 = ([\d_ *]+);', config).split("*"))
        for name in ("DEFAULT", "MIN", "MAX")}
    native = {}
    for name in NAMES:
        constructor = function(spec, "create_" + name + "_tool" + ("_v2" if name in ("spawn_agent", "wait_agent", "interrupt_agent") else ""))
        fields = primitives(constructor)
        if name == "spawn_agent":
            common = function(spec, "spawn_agent_common_properties_v2")
            fields.update(primitives(common))
            fields["agent_type"] = dict(type="string", description=json.loads(one(r'format!\(\s*(' + STRING + r')', common)).format(agent_type_description=role_guidance))
            fields["model"] = dict(type="string", description=json.loads(one(r'const SPAWN_AGENT_MODEL_OVERRIDE_DESCRIPTION: &str =\s*(' + STRING + r');', spec)))
        if name in ("spawn_agent", "send_message", "followup_task"):
            fields["message"]["encrypted"] = True
        if name == "wait_agent":
            template = json.loads(one(r'format!\(\s*(' + STRING + r')', function(spec, "wait_agent_tool_parameters_v2")))
            fields["timeout_ms"] = dict(type="number", description=template.format(*(timeouts[k] for k in ("default", "min", "max"))))
        parameters = dict(type="object", properties=dict(sorted(fields.items())), additionalProperties=False)
        required = {"spawn_agent": ["task_name", "message"], "send_message": ["target", "message"],
                    "followup_task": ["target", "message"], "interrupt_agent": ["target"]}.get(name)
        if required:
            parameters["required"] = required
        schema_name = {"spawn_agent": "spawn_agent_output_schema_v2", "wait_agent": "wait_output_schema_v2",
                       "interrupt_agent": "agent_previous_status_output_schema", "list_agents": "list_agents_output_schema"}.get(name)
        previous = json.loads(one(r'agent_previous_status_output_schema\(\s*(' + STRING + r'),', constructor)) if name == "interrupt_agent" else None
        native[name] = dict(name=name,
                            description=spawn_description if name == "spawn_agent" else json.loads(one(r'description:\s*(' + STRING + r')', constructor)),
                            parameters=parameters, output_schema=output(schema_name, previous) if schema_name else None)
    supported = copy.deepcopy(native)
    edits = []

    def edit(path, before, after, reason):
        edits.append(dict(path=path, before=before, after=after, reason=reason))

    for name in ("spawn_agent", "send_message", "followup_task"):
        before = supported[name]["parameters"]["properties"]["message"].pop("encrypted")
        edit(f"tools.{name}.parameters.properties.message.encrypted", before, None,
             "Responses-only encryption marker is not a Pi provider-neutral parameter capability.")
    wait = supported["wait_agent"]
    before = wait["description"]
    wait["description"] = before.replace("a summary of which agents have updates (if any)", "a mailbox-activity summary without agent names")
    if wait["description"] == before:
        raise ValueError("Expected pinned wait-description discrepancy")
    edit("tools.wait_agent.description", before, wait["description"],
         "The pinned handler returns Wait completed., not updating-agent names; see multi_agents_v2/wait.rs:155-182.")
    wait["parameters"]["properties"]["timeout_ms"]["type"] = "integer"
    edit("tools.wait_agent.parameters.properties.timeout_ms.type", "number", "integer",
         "The pinned handler deserializes Option<i64>; fractional numbers are not accepted. Values below the minimum clamp, so no schema minimum is added.")
    return dict(tools=supported, roles=roles), native, edits, timeouts, output("agent_status_output_schema")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("checkout", type=Path)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    sources = {path: subprocess.check_output(["git", "-C", str(args.checkout), "show", f"{REVISION}:{path}"]) for path in SOURCES}
    manifest = dict(repository="https://github.com/openai/codex", revision=REVISION,
                    sha256={path: hashlib.sha256(data).hexdigest() for path, data in sources.items()})
    manifest_path = ROOT / "docs/code-mode-contract/subagents-v2-source-manifest.json"
    if manifest_path.exists() and json.loads(manifest_path.read_text()) != manifest:
        raise ValueError("Pinned source manifest mismatch")
    contract, native, edits, timeouts, status_schema = extract(sources)
    result = dict(revision=REVISION, source_paths=SOURCES,
                  configuration=dict(version="V2", available_models=[], user_defined_roles={}, expose_agent_type=True,
                                     hide_agent_type_model_reasoning=True, expose_spawn_agent_model_overrides=True,
                                     usage_hint_text=None, description_override=None, wait_timeouts_ms=timeouts,
                                     wait_agent_enabled=True, disable_direct_message=False, message_board_in_memory=False),
                  native_tools=native, contract=contract, edits=edits, agent_status_schema=status_schema,
                  result_evidence=dict(send_message="Empty text; multi_agents_v2/message_tool.rs:115",
                                       followup_task="Empty text; multi_agents_v2/message_tool.rs:115",
                                       wait_agent="Wait completed. / Wait interrupted by new input. / Wait timed out.; multi_agents_v2/wait.rs:155-182"))
    result["sha256"] = {key: hashlib.sha256(json.dumps(result[key], ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
                        for key in ("native_tools", "contract")}
    for path, value in ((manifest_path, manifest), (ROOT / "docs/code-mode-contract/subagents-v2-supported.json", result)):
        if args.check:
            if not path.exists() or json.loads(path.read_text()) != value:
                raise ValueError(f"Generated artifact differs: {path}")
        else:
            path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n")
    print("Subagent V2 contract " + ("verified" if args.check else "generated"))


if __name__ == "__main__":
    main()
