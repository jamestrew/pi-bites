mod cli;
mod http;
mod search;
mod types;

use anyhow::Context;

const MAX_RESPONSE_BYTES: usize = 6 * 1024 * 1024;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args = cli::parse_args()?;
    let url = http::search_url()?;
    let headers = http::search_headers()?;
    let model = args
        .model
        .clone()
        .filter(|model| !model.trim().is_empty())
        .context("web_run requires a model selected by the Pi model registry")?;
    let request = search::build_search_request(&args, model);

    let mut response = http::build_client()?
        .post(&url)
        .headers(headers)
        .json(&request)
        .send()
        .await
        .with_context(|| format!("web_run search request failed for `{url}`"))?;
    let status = response.status();
    let body = http::read_bounded_body(&mut response, MAX_RESPONSE_BYTES).await?;
    if !status.is_success() {
        anyhow::bail!("web_run search failed for `{url}`: HTTP {status} {body}");
    }

    let response = search::parse_search_response(&body)?;
    println!("{}", search::tool_output(response));
    Ok(())
}
