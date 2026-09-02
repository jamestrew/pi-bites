import { sanitizeText } from "../../subagents/ui/text-lines.js";

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function displayText(value: unknown): string {
  return typeof value === "string" ? sanitizeText(value).replace(/\s+/gu, " ").trim() : "";
}

function openTarget(value: unknown): string {
  const target = displayText(value);
  if (/^https?:\/\//iu.test(target)) return target;
  if (/^turn\d+search\d+$/u.test(target)) return "search result";
  if (/^turn\d+(?:view|fetch)\d+$/u.test(target)) return "page";
  return "result";
}

export function summarizeWebRunCall(params: Record<string, unknown>): string | undefined {
  const summaries: string[] = [];
  const searches = params.search_query;
  if (Array.isArray(searches) && searches.length > 0) {
    const query = displayText(record(searches[0])?.q);
    summaries.push(
      `Search${query ? ` ${query}` : ""}${searches.length > 1 ? ` (+${searches.length - 1})` : ""}`,
    );
  }

  const images = params.image_query;
  if (Array.isArray(images) && images.length > 0) {
    const query = displayText(record(images[0])?.q);
    summaries.push(
      `Images${query ? ` ${query}` : ""}${images.length > 1 ? ` (+${images.length - 1})` : ""}`,
    );
  }

  const opens = params.open;
  if (Array.isArray(opens) && opens.length > 0) {
    const first = record(opens[0]);
    const line = typeof first?.lineno === "number" ? ` at line ${first.lineno}` : "";
    summaries.push(
      opens.length > 1
        ? `Open ${opens.length} results`
        : `Open ${openTarget(first?.ref_id)}${line}`,
    );
  }

  const clicks = params.click;
  if (Array.isArray(clicks) && clicks.length > 0) {
    const id = record(clicks[0])?.id;
    summaries.push(
      clicks.length > 1
        ? `Click ${clicks.length} links`
        : `Click link${typeof id === "number" ? ` ${id}` : ""}`,
    );
  }

  const finds = params.find;
  if (Array.isArray(finds) && finds.length > 0) {
    const pattern = displayText(record(finds[0])?.pattern);
    summaries.push(
      `Find${pattern ? ` ${pattern}` : ""}${finds.length > 1 ? ` (+${finds.length - 1})` : ""}`,
    );
  }

  return summaries.length > 0 ? summaries.join(" · ") : undefined;
}
