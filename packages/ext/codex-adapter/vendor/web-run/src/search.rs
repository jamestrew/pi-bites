use anyhow::Context;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::cli::WebRunArgs;
use crate::types::{AllowedCaller, ExternalWebAccess, SearchRequest, SearchResponse};

pub fn build_search_request(args: &WebRunArgs, model: String) -> SearchRequest {
    let mut settings = args.settings.clone().unwrap_or_default();
    settings.allowed_callers = Some(vec![AllowedCaller::Direct]);
    settings.external_web_access = Some(ExternalWebAccess(true));
    SearchRequest {
        id: args
            .id
            .clone()
            .filter(|id| !id.trim().is_empty())
            .unwrap_or_else(|| Uuid::new_v4().to_string()),
        model,
        commands: Some(args.commands.clone()),
        settings: Some(settings),
        max_output_tokens: args.max_output_tokens,
    }
}

pub fn parse_search_response(body: &str) -> anyhow::Result<SearchResponse> {
    serde_json::from_str(body).context("failed to decode web_run search response")
}

pub fn tool_output(response: SearchResponse) -> Value {
    json!({
        "output_text": response.output,
        "search_results": response.results.unwrap_or_default(),
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{build_search_request, parse_search_response, tool_output};
    use crate::cli::WebRunArgs;
    use crate::types::{SearchCommands, SearchQuery, SearchResponseLength};

    #[test]
    fn serializes_explicit_commands_without_conversation_input() {
        let args = WebRunArgs {
            id: Some("navigation-1".to_string()),
            commands: SearchCommands {
                search_query: Some(vec![SearchQuery {
                    q: "BBC headlines".to_string(),
                    recency: Some(2),
                    domains: Some(vec!["bbc.co.uk".to_string()]),
                }]),
                response_length: Some(SearchResponseLength::Short),
                ..Default::default()
            },
            model: Some("gpt-codex".to_string()),
            settings: None,
            max_output_tokens: Some(8000),
        };
        assert_eq!(
            serde_json::to_value(build_search_request(&args, "gpt-codex".to_string()))
                .expect("request"),
            json!({
                "id": "navigation-1",
                "model": "gpt-codex",
                "commands": {
                    "search_query": [{"q":"BBC headlines","recency":2,"domains":["bbc.co.uk"]}],
                    "response_length": "short"
                },
                "settings": {"allowed_callers":["direct"],"external_web_access":true},
                "max_output_tokens": 8000
            })
        );
        let response = parse_search_response(
            r#"{"encrypted_output":"opaque","output":"cited result","results":[{"ref_id":"turn0search0"}]}"#,
        )
        .expect("response");
        assert_eq!(
            tool_output(response),
            json!({"output_text":"cited result","search_results":[{"ref_id":"turn0search0"}]})
        );
    }
}
