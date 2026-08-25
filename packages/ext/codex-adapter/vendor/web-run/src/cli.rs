use std::env;
use std::io::Read;

use anyhow::Context;
use serde::Deserialize;

use crate::types::{SearchCommands, SearchSettings};

#[derive(Debug, Deserialize)]
pub struct WebRunArgs {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(flatten)]
    pub commands: SearchCommands,
    pub model: Option<String>,
    #[serde(default)]
    pub settings: Option<SearchSettings>,
    #[serde(default)]
    pub max_output_tokens: Option<u64>,
}

pub fn parse_args() -> anyhow::Result<WebRunArgs> {
    let mut args = env::args().skip(1);
    let first = args.next();
    if first.as_deref().is_some_and(|value| value != "-") || args.next().is_some() {
        anyhow::bail!("web_run accepts JSON on stdin using `web_run -`");
    }
    let mut input = String::new();
    std::io::stdin()
        .read_to_string(&mut input)
        .context("failed to read web_run JSON arguments from stdin")?;
    if input.trim().is_empty() {
        anyhow::bail!("web_run requires JSON arguments")
    }
    serde_json::from_str(input.trim()).context("failed to parse web_run JSON arguments")
}
