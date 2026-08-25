// Adapted from openai/codex codex-api search types and ext/web-search.
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize)]
pub struct SearchRequest {
    pub id: String,
    pub model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub commands: Option<SearchCommands>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub settings: Option<SearchSettings>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_output_tokens: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct SearchCommands {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub search_query: Option<Vec<SearchQuery>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_query: Option<Vec<SearchQuery>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub open: Option<Vec<OpenOperation>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub click: Option<Vec<ClickOperation>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub find: Option<Vec<FindOperation>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_length: Option<SearchResponseLength>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SearchQuery {
    pub q: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recency: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub domains: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct OpenOperation {
    pub ref_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lineno: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ClickOperation {
    pub ref_id: String,
    pub id: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FindOperation {
    pub ref_id: String,
    pub pattern: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SearchResponseLength {
    Short,
    Medium,
    Long,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct SearchSettings {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub search_context_size: Option<SearchContextSize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allowed_callers: Option<Vec<AllowedCaller>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub external_web_access: Option<ExternalWebAccess>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SearchContextSize {
    Low,
    Medium,
    High,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AllowedCaller {
    Direct,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(transparent)]
pub struct ExternalWebAccess(pub bool);

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct SearchResponse {
    #[allow(dead_code)]
    pub encrypted_output: Option<String>,
    pub output: String,
    #[serde(default)]
    pub results: Option<Vec<Value>>,
}
