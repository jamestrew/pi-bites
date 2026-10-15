# Local prompt-cache diagnostics

Pi Bites captures rolling cache diagnostics by default, independently of Pi's
`showCacheMissNotices`. `/cache-debug on|off|status` controls capture in the current
extension instance. Off clears the baseline and pending entries; on starts cold.
Reload starts default-on again. There is no backend, upload, extra model call or
configuration file. Child sessions also capture their own diagnostics.

Capture is provider-agnostic, including GitHub Copilot, AWS Bedrock and custom
proxies. Providers must invoke Pi's request hook and return normalized assistant
usage. Request inspection recognizes `input`, `messages` and `contents`, leading
instructions/system blocks, and ordinary or nested tool declarations. Other
object payloads (including scalar/object history or opaque tool declarations) use
a whole-body fingerprint, without per-message localization.
Status reports inspection/correlation limitations, baseline state and reset reason.

The recorder fingerprints instructions/system messages, ordered tools, cache key,
remaining request options and individual ordered input items with a random
in-memory HMAC key per reset generation. It retains no prompt bodies, tool arguments/results, raw
keys, credentials, arbitrary headers or raw provider events, and never changes requests or
model-visible context. Persisted fingerprints cannot be compared across resets;
the HMAC key is never persisted. Session/branch replacement, reload, successful
compaction and context rewrites reset the baseline. Failed compaction does not.

Successful, correlated assistant usage advances the baseline on every response,
including hits and misses. First requests are only baselines. An estimated loss
above 1,024 tokens is significant at 20,000 tokens or $0.10 excess cost. Zero-read/zero-write responses
need earlier reported cache activity. Substantial partial hits remain eligible.
Missing pricing leaves the cost estimate unavailable, not the token threshold.
Missing or invalid normalized usage, failed responses and ambiguous correlation
invalidate continuity. Responses-style stream events provide extra usage/response
ID validation when present; other APIs do not need Responses IDs or raw stream
events. Each comparison records its usage source. Pi can normalize omitted cache
metrics to zero, so normalized-only comparisons explicitly warn that a miss is
not confirmed. Providers that never report cache activity cannot establish a miss.

Both anomaly snapshots include bounded transport metadata. `after_provider_response`
records the observed HTTP response count and up to eight ordered responses with
status codes and allowlisted `x-request-id`, `request-id` and `openai-request-id`
values. These provider request IDs are retained verbatim for support investigations;
they are not HMAC fingerprints. Header names are case-insensitive; IDs must be
1–256 ASCII letters, digits, underscores, dots, colons or hyphens. Only the first
128 header names per response are inspected; header overflow is marked. Other
headers are never retained.

The first eight assistant diagnostics are inspected for `provider_transport_failure`,
including failures followed by a successful SSE fallback. Only its type, valid
timestamp, known transport/fallback/phase values, stream-start flag and request
byte count are retained. Unknown fields, free-form errors and stacks are omitted;
diagnostic overflow is marked. HTTP response-count overflow does not invalidate
the prompt comparison, but the retained attempt list is incomplete.

HTTP metadata is associated with the sole current logical observation: the response
hook supplies no request/provider identity. WebSocket sends and handshakes are not
observed. Missing callbacks or diagnostics mean unknown coverage, not proof of a
particular transport or absence of retries; some internal retries and sticky
fallbacks remain invisible. No healthy-hit entries are added for this metadata.

Significant anomalies are retained regardless of elapsed time. Actual cache
retention depends on the provider, proxy and request options; no guessed TTL
suppresses capture. The monotonic **logical request gap** is between request-hook
observations, not idle time or exact server cache age. Wall-clock timestamps are
stored separately. Older entries may retain their original local TTL annotation.

Anomalies flush at `turn_end` into `pi-bites:cache-debug` custom session entries,
outside model context. Expand their transcript rows to inspect the complete
previous/current fingerprints, usage and comparison without an older persisted
hit. JSONL exports contain the same metadata. Pi's HTML export embeds custom data
but currently does not visually render custom-entry details. Healthy hits write
no entries; coverage failures are status-only.

Inspection is **logical pre-transport**, not exact wire capture: later extension
handlers can change the body; WebSocket continuation can rewrite it to a response
ID and input delta; internal retries/fallback can follow one observation. Stable
fingerprints cannot distinguish transport/provider causes. Lost reuse/cost is an
estimate, not proof of cause or billing. Provider-added cache markers (for example
Anthropic `cache_control` and Bedrock `cachePoint`) can move as history grows; a
changed converted prefix does not identify the responsible extension. Virtual
routing that changes the observed provider/model/API invalidates correlation;
cache-warming requests can also make correlation ambiguous.

Inspection is bounded to 2,048 input items, 128 tools, 8 MiB of fingerprinted
JSON/binary data, 100,000 JSON nodes, depth 64, and eight pending anomalies per turn. Overflow is a
coverage limitation, never a complete comparison. Only the previous comparable
request, current in-flight observation and pending anomalies are retained.
