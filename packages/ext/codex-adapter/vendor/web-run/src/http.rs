use std::env;
use std::time::Duration;

use anyhow::Context;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};

pub fn search_url() -> anyhow::Result<String> {
    env::var("PI_CODEX_SEARCH_URL")
        .ok()
        .filter(|url| !url.trim().is_empty())
        .context("PI_CODEX_SEARCH_URL was not supplied by the Pi model registry route")
}

pub fn search_headers() -> anyhow::Result<HeaderMap> {
    let encoded = env::var("PI_CODEX_SEARCH_HEADERS")
        .context("PI_CODEX_SEARCH_HEADERS was not supplied by the Pi model registry route")?;
    let values: serde_json::Map<String, serde_json::Value> =
        serde_json::from_str(&encoded).context("failed to parse registry search headers")?;
    let mut headers = HeaderMap::new();
    for (name, value) in values {
        let value = value
            .as_str()
            .context("registry search header values must be strings")?;
        headers.insert(
            HeaderName::from_bytes(name.as_bytes()).context("invalid registry header name")?,
            HeaderValue::from_str(value).context("invalid registry header value")?,
        );
    }
    Ok(headers)
}

pub fn build_client() -> anyhow::Result<reqwest::Client> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(60))
        .build()
        .context("failed to build web_run HTTP client")
}

pub async fn read_bounded_body(
    response: &mut reqwest::Response,
    limit: usize,
) -> anyhow::Result<String> {
    if response
        .content_length()
        .is_some_and(|content_length| content_length > limit as u64)
    {
        anyhow::bail!("web_run search response exceeded {limit} bytes");
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .context("failed to read web_run search response")?
    {
        if body.len().saturating_add(chunk.len()) > limit {
            anyhow::bail!("web_run search response exceeded {limit} bytes");
        }
        body.extend_from_slice(&chunk);
    }
    String::from_utf8(body).context("web_run search response was not valid UTF-8")
}

#[cfg(test)]
mod tests {
    use super::search_headers;

    #[test]
    fn accepts_only_explicit_registry_headers() {
        unsafe {
            std::env::set_var(
                "PI_CODEX_SEARCH_HEADERS",
                r#"{"Authorization":"Bearer test","chatgpt-account-id":"account"}"#,
            );
        }
        let headers = search_headers().expect("headers");
        assert_eq!(headers["authorization"], "Bearer test");
        assert_eq!(headers["chatgpt-account-id"], "account");
    }
}
