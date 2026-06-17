export type Usage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
};

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

export function buildDoneStats(toolUses: number, usage: Usage, durationMs?: number): string {
  const parts: string[] = [];
  parts.push(`${toolUses} tool use${toolUses !== 1 ? "s" : ""}`);

  const usageParts: string[] = [];
  if (usage.input > 0) usageParts.push(`↑${formatTokenCount(usage.input)}`);
  if (usage.output > 0) usageParts.push(`↓${formatTokenCount(usage.output)}`);
  if (usage.cacheRead > 0) usageParts.push(`R${formatTokenCount(usage.cacheRead)}`);
  if (usage.cacheWrite > 0) usageParts.push(`W${formatTokenCount(usage.cacheWrite)}`);

  const cacheHitDenominator = usage.input + usage.cacheRead;
  if (cacheHitDenominator > 0 && usage.cacheRead > 0) {
    const cacheHit = (usage.cacheRead / cacheHitDenominator) * 100;
    usageParts.push(`CH${Number(cacheHit.toFixed(1))}%`);
  }

  if (usage.cost > 0) usageParts.push(`$${formatCost(usage.cost)}`);
  if (usageParts.length > 0) parts.push(usageParts.join(" "));

  if (durationMs !== undefined && durationMs > 0) {
    parts.push(`${(durationMs / 1000).toFixed(1)}s`);
  }

  return parts.join(" · ");
}
