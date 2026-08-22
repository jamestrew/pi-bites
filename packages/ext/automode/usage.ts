import type { Usage } from "@earendil-works/pi-ai";
import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface AutoModeUsageRecord {
  type: "automode_usage";
  version: 1;
  parentSessionId: string;
  timestamp: number;
  provider: string;
  model: string;
  usage: Usage;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function nonNegativeNumberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

export function decodeAutoModeUsageRecord(value: unknown): AutoModeUsageRecord | undefined {
  if (
    !isRecord(value) ||
    value.type !== "automode_usage" ||
    value.version !== 1 ||
    typeof value.parentSessionId !== "string" ||
    !value.parentSessionId ||
    typeof value.timestamp !== "number" ||
    typeof value.provider !== "string" ||
    !value.provider ||
    typeof value.model !== "string" ||
    !value.model ||
    !isRecord(value.usage)
  ) {
    return undefined;
  }

  const usage = value.usage;
  const cost = isRecord(usage.cost) ? usage.cost : {};
  return {
    type: "automode_usage",
    version: 1,
    parentSessionId: value.parentSessionId,
    timestamp: nonNegativeNumberOrZero(value.timestamp),
    provider: value.provider,
    model: value.model,
    usage: {
      input: nonNegativeNumberOrZero(usage.input),
      output: nonNegativeNumberOrZero(usage.output),
      cacheRead: nonNegativeNumberOrZero(usage.cacheRead),
      cacheWrite: nonNegativeNumberOrZero(usage.cacheWrite),
      ...(usage.cacheWrite1h === undefined
        ? {}
        : { cacheWrite1h: nonNegativeNumberOrZero(usage.cacheWrite1h) }),
      ...(usage.reasoning === undefined
        ? {}
        : { reasoning: nonNegativeNumberOrZero(usage.reasoning) }),
      totalTokens: nonNegativeNumberOrZero(usage.totalTokens),
      cost: {
        input: nonNegativeNumberOrZero(cost.input),
        output: nonNegativeNumberOrZero(cost.output),
        cacheRead: nonNegativeNumberOrZero(cost.cacheRead),
        cacheWrite: nonNegativeNumberOrZero(cost.cacheWrite),
        total: nonNegativeNumberOrZero(cost.total),
      },
    },
  };
}

function getAutoModeUsageFile(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  return join(agentDir, "pi-bites", "usage", "automode.jsonl");
}

export async function appendAutoModeUsageRecord(record: AutoModeUsageRecord): Promise<void> {
  const file = getAutoModeUsageFile();
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(record)}\n`, "utf8");
}
