use codex_code_mode_protocol::{ToolDefinition, build_exec_tool_description};
use std::{collections::BTreeMap, io};

fn main() {
    let tools: Vec<ToolDefinition> =
        serde_json::from_reader(io::stdin()).expect("tool definitions");
    let base = build_exec_tool_description(&[], &[], &BTreeMap::new(), 10_000, true);
    let sections: Vec<String> = tools
        .iter()
        .map(|tool| {
            build_exec_tool_description(
                std::slice::from_ref(tool),
                &[],
                &BTreeMap::new(),
                10_000,
                true,
            )
            .strip_prefix(&format!("{base}\n\n"))
            .expect("native tool section")
            .to_owned()
        })
        .collect();
    serde_json::to_writer(
        io::stdout(),
        &serde_json::json!({"base":base, "sections":sections}),
    )
    .unwrap();
}
