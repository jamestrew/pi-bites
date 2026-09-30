# Direct OpenAI subscription usage: public API evidence

## Finding

OpenAI documents the new ChatGPT grant for inference, but the inspected public
sources do **not** document a replacement subscription-quota query compatible
with legacy `backend-api/wham/usage`. This does not prove no internal or future
API exists.

## Primary sources

- [Registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
  specifies resource `https://api.openai.com/v1` and plan-use scope
  `chatgpt.tokens.use.direct`. Identity sign-in alone does not authorize plan use.
- [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
  documents public Responses inference and explicitly says not to target
  ChatGPT's `backend-api` endpoints. It establishes no legacy quota authorization.
- [Accounts and sessions — Tracking usage](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions#tracking-usage)
  tells tools to link to <https://chatgpt.com/settings/usage> for app usage and
  plan/credit settings. It supplies no machine-readable quota/reset contract.
- [Errors and recovery](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery)
  documents `subscription_sharing_usage_limit_exceeded` (429) and
  `subscription_sharing_usage_unavailable` (503), including streaming failures.
  For 429, pause requests and link to settings. Do not infer whole-plan exhaustion
  or a reset time: an app-specific limit may apply.
- [Organization Usage API](https://developers.openai.com/api/reference/resources/organization/subresources/usage/methods/get_completions)
  uses `$OPENAI_ADMIN_KEY` and returns bucketed organization consumption, not
  ChatGPT subscription entitlement/remaining/reset information.
- [API rate limits](https://developers.openai.com/api/docs/guides/rate-limits)
  documents request/token `x-ratelimit-*` headers, not a verified ChatGPT
  five-hour/weekly quota-percentage contract.

## Consequence and validation limits

`packages/ext/token-count/index.ts` now uses separately authenticated legacy Codex
OAuth for its `codex:` usage display while a direct OpenAI subscription is selected.
Without legacy OAuth, its settings-link fallback matches the documented route.
Neither ordinary OpenAI API keys nor the direct subscription grant are sent to the
legacy endpoint. This does not establish direct subscription-quota support.

Research used unauthenticated public reads, including the complete
[SIWC documentation export](https://developers.openai.com/siwc/llms-full.txt).
No credentials were accessed, authenticated calls made, or candidate endpoints
probed. A new implementation needs a compatible documented auth/API contract and
an authorized live check; no such quota contract was found in this bounded review.

## Codex source trace

Inspected `/home/jt/projects/codex` at commit
`1a89aec960cd92e2c59ce49b7f3c3347a915e4a9` (2026-09-26; workspace version
`0.0.0`). Paths below are relative to its `codex-rs/` directory.

```text
TUI refresh → account/rateLimits/read RPC
  require auth.uses_codex_backend()
  GET https://chatgpt.com/backend-api/wham/usage
    Authorization: Bearer <Codex access token>
    ChatGPT-Account-ID: <account ID, when available>
  account-usage snapshots → "codex" five-hour/weekly status items
```

- **Endpoint/auth:** `app-server/src/request_processors/account_processor.rs:1115-1147`
  gates backend auth and creates the client. Default base is
  `core/src/config/mod.rs:4397`; GET URL is
  `backend-client/src/client/rate_limit_resets.rs:69-79,124-128`.
  Its alternate configured-base path `/api/codex/usage` is not established as a
  direct OpenAI subscription endpoint. Headers come from
  `model-provider/src/auth.rs:307-323` and `bearer_auth_provider.rs:31-45`.
- **Login grant:** `login/src/server.rs:584-613` requests
  `openid profile email offline_access api.connectors.read api.connectors.invoke`
  with **no resource parameter**. Client ID is
  `app_EMoamEEZ73f0CkXaXp7hrann` (`login/src/auth/manager.rs:1717`). This differs
  from Pi's resource `https://api.openai.com/v1` and `chatgpt.tokens.use.direct`.
  No matching direct-grant scope was found in inspected login/backend/provider code.
- **UI/data:** `protocol/src/protocol.rs:2347-2359,2390-2398` models percentage,
  duration and reset timestamp. `tui/src/chatwidget/rate_limits.rs:374-408`
  caches account snapshots by limit ID; `status_surfaces.rs:760-774` selects
  `codex` windows. Streamed updates explicitly cannot overwrite status data.
- **Refresh:** `tui/src/app/background_requests.rs:79-124` handles startup,
  periodic, status/menu and recovery reads. `rate_limit_refresh.rs:35-129`
  coalesces pending reads and rejects stale/failed completions.
  `codex-api/src/sse/responses.rs:79` emits quota-header events; parsing
  `x-codex-*` headers in `codex-api/src/rate_limits.rs` establishes no direct-grant
  compatibility.

No credentials, authenticated calls or Codex edits. This checkout provides no
verified replacement for the direct grant; newer revisions may differ.
