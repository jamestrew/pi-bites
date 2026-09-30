# OpenAI model and subscription compatibility (#365)

## Supported routes

| Selected route                         | Code Mode on GPT-6.1 Sol | Account usage                     | Nested web_run                      |
| -------------------------------------- | ------------------------ | --------------------------------- | ----------------------------------- |
| OpenAI ChatGPT subscription (`openai`) | Yes                      | Unavailable; use ChatGPT settings | Unavailable                         |
| OpenAI API key (`openai`)              | Yes                      | No subscription request           | Unavailable                         |
| Legacy Codex OAuth (`openai-codex`)    | Yes                      | Existing Codex usage endpoint     | Existing Codex search endpoint      |
| Explicit compatible Responses provider | Yes, for eligible IDs    | No inferred subscription access   | Its configured search endpoint      |
| Unauthenticated route                  | Model eligibility only   | No usage request                  | Route-specific authentication error |

Direct OpenAI subscription inference is not proof that the grant can use hosted
search or the legacy backend. Do not add `openai` to `webSearchProviders` as a
workaround; it is excluded. Configure an independently verified proxy under its
own provider ID. Ordinary API keys are never used for subscription usage or legacy
Codex search, even if a token resembles a JWT with account claims.

`allowOpenAICodexFallback: true` remains an explicit authorization to use a
separately authenticated legacy account. Without it, selecting direct OpenAI never
uses stored Codex credentials. A selected compatible route never retries with
another account after failure. Search navigation and citations are auth-scoped;
session replacement retires pending results. Usage caches include resolved auth
and account headers and suppress superseded completions.

## Upstream evidence

Inspected the official npm distributions of `@earendil-works/pi-ai@0.99.1` and
`@earendil-works/pi-coding-agent@0.99.1`, alongside installed 0.87.1:

- `pi-ai/dist/providers/openai.js` marks OAuth as a subscription and retains
  `https://api.openai.com/v1`.
- `pi-ai/dist/auth/oauth/openai-chatgpt.js` requests resource
  `https://api.openai.com/v1` and scope `chatgpt.tokens.use.direct`. Its
  `toAuth` supplies an access token; it does not establish legacy account-ID or
  backend permissions.
- `pi-ai/dist/providers/openai-codex.js` retains the distinct
  `https://chatgpt.com/backend-api` provider.
- `pi-ai/dist/api/openai-responses.js` directs subscription exhaustion recovery
  to `https://chatgpt.com/settings/usage`. The inspected distribution supplies no
  direct subscription usage endpoint or hosted-search implementation proving
  compatibility with the bundled `alpha/search` protocol.
- The public registry `getProviderAuth` API resolves credentials and their source
  together; canonical OAuth reports `source: "OAuth"`. This avoids inferring
  subscription authentication from provider names, arbitrary Bearer tokens, or
  a potentially stale `isUsingOAuth` availability snapshot. Provider subscription
  metadata further identifies the direct OpenAI subscription for its limitation
  status.

These public APIs already exist in 0.87.1. No dependency upgrade, OAuth
implementation, endpoint guessing, credential migration, native contract
regeneration, or host change is required.

## Recovery and validation limits

For direct OpenAI usage, open <https://chatgpt.com/settings/usage>. Repeating
`/login openai` does not enable usage or web search in pi-bites. For missing or
expired legacy authentication, use `/login openai-codex`; for compatible-provider
failures, repair that provider's configured authentication and endpoint. Selecting
a legacy model or enabling explicit fallback uses that legacy account, not the
account selected through the new login.

Offline tests exercise registered activation, provider payloads before network
access, routed credential destinations, unsupported routes, account changes and
stale contexts. GPT-6.1 base and Sol IDs are added deliberately; no other GPT-6.1
variant or future family is implied. Existing GPT-5.6/GPT-6 behavior and explicit
tool disables remain covered.

No authenticated live check of the new subscription's usage or search endpoints
is performed, and no new endpoint support is claimed. The direct route remains
unsupported until upstream documents a compatible capability and an authorized
live smoke verifies it. Source inspection of 0.99.1 is not a full-runtime
certification of that Pi version; tests run against the existing development
baseline.
