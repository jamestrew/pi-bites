/** Auxiliary usage persistence; accounting and session-history parsing belong to consumers. */
import type { Usage } from "@earendil-works/pi-ai";
import { closeSync, fstatSync, openSync, readdirSync, readSync } from "node:fs";
import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type SubagentUsageRecord = {
  type: "subagent_usage";
  subagent: string;
  sessionId: string;
  parentSessionId: string;
  timestamp: number;
  provider: string;
  model: string;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: { total: number };
  };
};

export type DecodedSubagentUsageRecord = Pick<SubagentUsageRecord, "type" | "subagent" | "usage"> &
  Partial<
    Pick<SubagentUsageRecord, "sessionId" | "parentSessionId" | "timestamp" | "provider" | "model">
  >;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function finiteNumberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Decode persisted usage, including legacy records without model/session metadata. */
export function decodeSubagentUsageRecord(value: unknown): DecodedSubagentUsageRecord | undefined {
  if (
    !isRecord(value) ||
    value.type !== "subagent_usage" ||
    typeof value.subagent !== "string" ||
    !isRecord(value.usage) ||
    (value.sessionId !== undefined && typeof value.sessionId !== "string") ||
    (value.parentSessionId !== undefined && typeof value.parentSessionId !== "string") ||
    (value.timestamp !== undefined && typeof value.timestamp !== "number") ||
    (value.provider !== undefined && typeof value.provider !== "string") ||
    (value.model !== undefined && typeof value.model !== "string")
  ) {
    return undefined;
  }

  const usage = value.usage;
  return {
    type: "subagent_usage",
    subagent: value.subagent,
    ...(value.sessionId === undefined ? {} : { sessionId: value.sessionId }),
    ...(value.parentSessionId === undefined ? {} : { parentSessionId: value.parentSessionId }),
    ...(value.timestamp === undefined ? {} : { timestamp: finiteNumberOrZero(value.timestamp) }),
    ...(value.provider === undefined ? {} : { provider: value.provider }),
    ...(value.model === undefined ? {} : { model: value.model }),
    usage: {
      input: finiteNumberOrZero(usage.input),
      output: finiteNumberOrZero(usage.output),
      cacheRead: finiteNumberOrZero(usage.cacheRead),
      cacheWrite: finiteNumberOrZero(usage.cacheWrite),
      cost: {
        total: finiteNumberOrZero(isRecord(usage.cost) ? usage.cost.total : usage.cost),
      },
    },
  };
}

export interface AutoModeUsageRecord {
  type: "automode_usage";
  version: 1;
  reviewer?: "guardian";
  parentSessionId: string;
  timestamp: number;
  provider: string;
  model: string;
  usage: Usage;
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
    ...(value.reviewer === "guardian" ? { reviewer: "guardian" as const } : {}),
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

export type UsageRecord = DecodedSubagentUsageRecord | AutoModeUsageRecord;

function getUsageDir(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  return join(agentDir, "pi-bites", "usage");
}

/** Rejects on I/O failure; producers decide how to report nonfatal persistence errors. */
export async function appendUsageRecord(
  record: SubagentUsageRecord | AutoModeUsageRecord,
): Promise<void> {
  const file = join(
    getUsageDir(),
    record.type === "subagent_usage" ? "subagents.jsonl" : "automode.jsonl",
  );
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, JSON.stringify(record) + "\n", "utf8");
}

function decodeLine(line: string): UsageRecord | undefined {
  try {
    const value: unknown = JSON.parse(line);
    return decodeSubagentUsageRecord(value) ?? decodeAutoModeUsageRecord(value);
  } catch {
    return undefined; // Malformed complete records do not block subsequent records.
  }
}

function getUsageFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const file = join(dir, entry.name);
        if (entry.isDirectory()) walk(file);
        else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(file);
      }
    } catch {
      // Missing/unreadable usage directories are fine.
    }
  };
  walk(getUsageDir());
  return files.sort();
}

/** New complete records only; replacement or observed truncation starts a new generation. */
export class UsageFileReader {
  private files = new Map<
    string,
    { offset: number; inode: number; device: number; size: number }
  >();

  readNewRecords(): UsageRecord[] {
    const records: UsageRecord[] = [];
    for (const file of getUsageFiles()) {
      let fd: number | undefined;
      try {
        fd = openSync(file, "r");
        const stat = fstatSync(fd);
        let state = this.files.get(file);
        // Append-only logs: an in-place rewrite that regrows between reads cannot be
        // detected by size/inode. Add generation markers if writers ever do that.
        if (
          !state ||
          state.inode !== stat.ino ||
          state.device !== stat.dev ||
          stat.size < state.size
        ) {
          state = { inode: stat.ino, device: stat.dev, offset: 0, size: 0 };
        }
        const chunk = Buffer.alloc(stat.size - state.offset);
        let bytes = 0;
        while (bytes < chunk.length) {
          const count = readSync(fd, chunk, bytes, chunk.length - bytes, state.offset + bytes);
          if (!count) break;
          bytes += count;
        }
        const end = chunk.subarray(0, bytes).lastIndexOf(10) + 1;
        for (const line of chunk.subarray(0, end).toString("utf8").split("\n")) {
          const record = decodeLine(line);
          if (record) records.push(record);
        }
        // Leave the unfinished tail on disk, including any incomplete UTF-8 bytes.
        state.offset += end;
        state.size = stat.size;
        this.files.set(file, state);
      } catch {
        // Files may disappear or become unreadable between discovery and reading.
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
    }
    return records;
  }
}

/** Historical auxiliary records, in sorted file order; unfinished tails are deferred. */
export async function* readUsageRecords(signal?: AbortSignal): AsyncGenerator<UsageRecord> {
  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    try {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (signal?.aborted) return;
        const file = join(dir, entry.name);
        if (entry.isDirectory()) await walk(file);
        else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(file);
      }
    } catch {
      // Missing/unreadable usage directories are fine.
    }
  };
  await walk(getUsageDir());
  for (const file of files.sort()) {
    if (signal?.aborted) return;
    let content: string;
    try {
      content = await readFile(file, "utf8");
    } catch {
      continue;
    }
    const lines = content.slice(0, content.lastIndexOf("\n") + 1).split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (i % 500 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
      if (signal?.aborted) return;
      const line = lines[i];
      if (!line?.trim()) continue;
      const record = decodeLine(line);
      if (record) yield record;
    }
  }
}
