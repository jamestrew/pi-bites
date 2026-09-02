import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { parsePatchActions } from "../../codex-adapter/patch/parser.js";
import { summarizeWebRunCall } from "../../codex-adapter/web-run/summary.js";
import type { LifetimeUsage } from "../usage.js";
import { sanitizeSingleLine, sanitizeText } from "./text-lines.js";

function formatApplyPatch(input: unknown): string {
  if (typeof input !== "string") return "ApplyPatch";
  try {
    const actions = parsePatchActions({ text: input });
    const describe = (action: (typeof actions)[number]) => {
      const path = sanitizeSingleLine(action.path);
      if (action.type === "add") return `Add ${path}`;
      if (action.type === "delete") return `Delete ${path}`;
      return action.movePath
        ? `Move ${path} → ${sanitizeSingleLine(action.movePath)}`
        : `Edit ${path}`;
    };
    const onlyAction = actions[0];
    if (actions.length === 1 && onlyAction) return `ApplyPatch(${describe(onlyAction)})`;

    const counts = new Map<string, number>();
    for (const action of actions) {
      const operation =
        action.type === "update" ? (action.movePath ? "move" : "edit") : action.type;
      counts.set(operation, (counts.get(operation) ?? 0) + 1);
    }
    const operations = ["add", "edit", "move", "delete"]
      .flatMap((operation) => {
        const count = counts.get(operation);
        return count ? [`${operation} ${count}`] : [];
      })
      .join(", ");
    const targets = actions.map((action) => describe(action).replace(/^\w+ /, "")).join(", ");
    return `ApplyPatch(${actions.length} actions · ${operations} · ${targets})`;
  } catch {
    return "ApplyPatch";
  }
}

export function normalizeToolArg(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

export function summarizeToolArg(value: unknown, maxLength = 120): string {
  const singleLine = sanitizeText(normalizeToolArg(value)).replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxLength) return singleLine;
  return `${singleLine.slice(0, maxLength)}...`;
}

export function wrapMultilineText(text: string, width: number): string[] {
  return text.split("\n").flatMap((line) => wrapTextWithAnsi(line, width));
}

export function formatToolCall(name: string, args: Record<string, unknown>): string {
  const cap = name.charAt(0).toUpperCase() + name.slice(1);

  if (name === "exec_command") {
    const command = summarizeToolArg(args.cmd ?? args.command, Number.POSITIVE_INFINITY);
    const details = [command, args.tty === true ? "TTY" : ""].filter(Boolean).join(" · ");
    return details ? `Exec(${details})` : "Exec";
  }

  if (name === "write_stdin") {
    const action = typeof args.chars === "string" && args.chars.length > 0 ? "Input" : "Poll";
    const session =
      summarizeToolArg(
        args.session_id ?? args.sessionId ?? args.process_id,
        Number.POSITIVE_INFINITY,
      ) || "?";
    return `${action}(session ${session})`;
  }

  if (name === "apply_patch") {
    return formatApplyPatch(args.input ?? args.patchText ?? args.patch);
  }

  if (name === "web_run") {
    const summary = summarizeWebRunCall(args);
    return summary ? `Web(${summary})` : "Web";
  }

  if (name === "view_image") {
    const path = summarizeToolArg(args.path, Number.POSITIVE_INFINITY);
    return path ? `View(${path})` : "View";
  }

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
