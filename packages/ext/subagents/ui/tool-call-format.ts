import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { LifetimeUsage } from "../usage.js";

export function normalizeToolArg(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

export function summarizeToolArg(value: unknown, maxLength = 120): string {
  const singleLine = normalizeToolArg(value).replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxLength) return singleLine;
  return `${singleLine.slice(0, maxLength)}...`;
}

export function wrapMultilineText(text: string, width: number): string[] {
  return text.split("\n").flatMap((line) => wrapTextWithAnsi(line, width));
}

export function formatToolCall(name: string, args: Record<string, unknown>): string {
  const cap = name.charAt(0).toUpperCase() + name.slice(1);

  if (name === "read") {
    const filePath = normalizeToolArg(args.path ?? "?");
    const offset = typeof args.offset === "number" ? args.offset : undefined;
    const limit = typeof args.limit === "number" ? args.limit : undefined;
    if (offset !== undefined || limit !== undefined) {
      const start = offset ?? 1;
      const end = limit !== undefined ? start + limit - 1 : "?";
      return `${cap}(${filePath}:${start}-${end})`;
    }
    return `${cap}(${filePath})`;
  }

  if (name === "grep") {
    return `${cap}(/${normalizeToolArg(args.pattern)}/ in ${normalizeToolArg(args.path ?? ".")})`;
  }

  if (name === "find") {
    return `${cap}(${normalizeToolArg(args.pattern ?? "*")} in ${normalizeToolArg(args.path ?? ".")})`;
  }

  if (name === "ls") return `${cap}(${normalizeToolArg(args.path ?? ".")})`;
  if (name === "bash") return `${cap}(${normalizeToolArg(args.command)})`;

  return `${cap}(${JSON.stringify(args)})`;
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1))}m`;
  if (tokens >= 1000) return `${Number((tokens / 1000).toFixed(1))}k`;
  return String(tokens);
}

function formatCost(cost: number): string {
  if (cost >= 1) return cost.toFixed(2);
  if (cost >= 0.01) return cost.toFixed(3);
  return cost.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}

export function buildDoneStats(
  toolUses: number,
  usage: LifetimeUsage,
  durationMs?: number,
): string {
  const parts = [`${toolUses} tool use${toolUses !== 1 ? "s" : ""}`];
  const usageParts: string[] = [];
  if (usage.input > 0) usageParts.push(`↑${formatTokenCount(usage.input)}`);
  if (usage.output > 0) usageParts.push(`↓${formatTokenCount(usage.output)}`);
  if ((usage.cacheRead ?? 0) > 0) usageParts.push(`R${formatTokenCount(usage.cacheRead ?? 0)}`);
  if (usage.cacheWrite > 0) usageParts.push(`W${formatTokenCount(usage.cacheWrite)}`);

  const cacheHitDenominator = usage.input + (usage.cacheRead ?? 0);
  if (cacheHitDenominator > 0 && (usage.cacheRead ?? 0) > 0) {
    const cacheHit = ((usage.cacheRead ?? 0) / cacheHitDenominator) * 100;
    usageParts.push(`CH${Number(cacheHit.toFixed(1))}%`);
  }

  if ((usage.cost ?? 0) > 0) usageParts.push(`$${formatCost(usage.cost ?? 0)}`);
  if (usageParts.length > 0) parts.push(usageParts.join(" "));
  if (durationMs !== undefined && durationMs > 0) parts.push(`${(durationMs / 1000).toFixed(1)}s`);

  return parts.join(" · ");
}
