/** Port of the pinned description.rs parser; output budgets belong to response formatting. */
export function parseExecSource(source: string) {
  if (typeof source !== "string" || !source.trim())
    throw new Error("exec requires non-empty JavaScript source");
  const newline = source.indexOf("\n");
  const first = (newline < 0 ? source : source.slice(0, newline)).trimStart();
  let code = source;
  let options: Record<string, unknown> = {};
  if (first.startsWith("// @exec:")) {
    code = newline < 0 ? "" : source.slice(newline + 1);
    if (!code.trim()) throw new Error("exec pragma must be followed by JavaScript source");
    const parsed: unknown = JSON.parse(first.slice("// @exec:".length).trim());
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("exec pragma must be a JSON object");
    options = parsed as Record<string, unknown>;
    for (const key of Object.keys(options)) {
      if (key !== "yield_time_ms" && key !== "max_output_tokens")
        throw new Error(`Unsupported exec pragma field: ${key}`);
    }
  }
  return {
    code,
    yieldTimeMs: unsignedInteger(options.yield_time_ms ?? 10_000, "yield_time_ms"),
    maxOutputTokens: unsignedInteger(options.max_output_tokens ?? 10_000, "max_output_tokens"),
  };
}

export function unsignedInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0)
    throw new Error(`${name} must be a non-negative safe integer`);
  return Number(value);
}
