# Codex status-line token accounting

Investigated 2026-09-12. This answers the `used-tokens` status-line option, whose settings help says “Total tokens used in session (omitted when zero).” It does not describe every Codex usage display.

## Exact calculation

At inspected Codex revision [`a62e98d18c6550e3bea152ed1b89d1e931dca961`](https://github.com/openai/codex/commit/a62e98d18c6550e3bea152ed1b89d1e931dca961), `used-tokens` displays cumulative **uncached input plus output**, rounded for compact display:

```text
used = max(total_input_tokens - total_cached_input_tokens, 0)
       + max(total_output_tokens, 0)
```

The decisive path is:

1. [`StatusLineItem::UsedTokens`](https://github.com/openai/codex/blob/a62e98d18c6550e3bea152ed1b89d1e931dca961/codex-rs/tui/src/chatwidget/status_surfaces.rs#L739) calls `status_line_total_usage().blended_total()`.
2. [`status_line_total_usage`](https://github.com/openai/codex/blob/a62e98d18c6550e3bea152ed1b89d1e931dca961/codex-rs/tui/src/chatwidget/status_controls.rs#L436) reads `token_info.total_token_usage`, not `last_token_usage`.
3. [`blended_total`](https://github.com/openai/codex/blob/a62e98d18c6550e3bea152ed1b89d1e931dca961/codex-rs/tui/src/token_usage.rs#L25) subtracts cached input and adds output. It does not use the raw `total_tokens` field.
4. [`append_last_usage`](https://github.com/openai/codex/blob/a62e98d18c6550e3bea152ed1b89d1e931dca961/codex-rs/protocol/src/protocol.rs#L2303) accumulates usage across model responses. A user turn can contain several such responses due to tool calls.
5. [`format_tokens_compact`](https://github.com/openai/codex/blob/a62e98d18c6550e3bea152ed1b89d1e931dca961/codex-rs/tui/src/status/helpers.rs#L119) formats the number with K/M/etc. suffixes.

Consequences: this is neither current context occupancy nor total input processed, nor a monetary bill. It excludes cache hits entirely rather than weighting them by price; output is counted as reported, with no extra addition for the separately reported reasoning subset. The separate 12,000-token baseline used for context percentages is **not involved** in `used-tokens`. See the distinct methods in [`token_usage.rs`](https://github.com/openai/codex/blob/a62e98d18c6550e3bea152ed1b89d1e931dca961/codex-rs/tui/src/token_usage.rs#L33).

## Local numerical corroboration

The installed CLI reports version 0.154.0. A recent local GPT-6 Astra session recorded by that version contains the following usage totals, reproducing the user's approximately 2.94K observation. This is numerical corroboration; the session has not been established as the exact greeting session the user meant. No conversation content or session identifier is included here.

| Field                              |    Tokens |
| ---------------------------------- | --------: |
| Input                              |    14,842 |
| Cached input                       |    11,904 |
| Output                             |         5 |
| Reported raw total                 |    14,847 |
| Computed status-line `used-tokens` | **2,943** |

`14,842 - 11,904 + 5 = 2,943`. Thus a small displayed value is compatible with a much larger input. It does not demonstrate a 2.94K system prompt. The checked-out source revision is recorded separately from the installed CLI version; this investigation does not claim they are identical builds.

## Comparison with Pi-bites `/context all`

Our [`estimateProviderToolTokens`](../../packages/ext/context.ts#L63) serializes `{name, description, input_schema: parameters}` and applies `ceil(text.length / 4)`. It estimates active top-level tools; nested documentation is charged to the enclosing `exec` description. It does not perform provider tokenization or count the exact grammar-tool wire payload. Category estimates remain independent even when the overall context total uses provider usage. See [`context.ts`](../../packages/ext/context.ts#L28).

Comparing that static tool estimate with Codex's cumulative uncached-input-plus-output status item mixes different quantities. To measure Code Mode's cost, compare actual input, cached input, output, model round trips, and context growth for the same route and workload.
