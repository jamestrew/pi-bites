import * as os from "node:os";
import * as path from "node:path";
import { readFileSync, statSync } from "node:fs";
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  loadTauDashboardSessions,
  type LoadTauDashboardSessionsResult,
  type TauDashboardSession,
} from "../../tau/index.js";
import { getDefaultTauAgentsDir } from "../tau/index.js";

type ReadonlyFooterDataProvider = {
  getGitBranch(): string | null;
  getExtensionStatuses(): ReadonlyMap<string, string>;
  onBranchChange(callback: () => void): () => void;
};

export type UsageTotals = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
};

const EMPTY_USAGE: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };

function getAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

function getExploreUsageFile(): string {
  return path.join(getAgentDir(), "pi-bites", "usage", "explore.jsonl");
}

export function formatTokens(count: number): string {
  if (count < 1_000) return count.toString();
  if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

function formatPercent(percent: number | null | undefined): string {
  return typeof percent === "number" && Number.isFinite(percent) ? `${percent.toFixed(1)}%` : "?%";
}

function shortenCwd(cwd: string): string {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (home && cwd.startsWith(home)) return `~${cwd.slice(home.length)}`;
  return cwd;
}

function addUsage(target: UsageTotals, usage: any): void {
  target.input += Number(usage?.input) || 0;
  target.output += Number(usage?.output) || 0;
  target.cacheRead += Number(usage?.cacheRead) || 0;
  target.cacheWrite += Number(usage?.cacheWrite) || 0;
  target.cost += Number(usage?.cost?.total ?? usage?.cost) || 0;
}

export function getMainSessionUsage(ctx: ExtensionContext): UsageTotals {
  const totals = { ...EMPTY_USAGE };
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type === "message" && entry.message.role === "assistant") {
      addUsage(totals, entry.message.usage);
    }
  }
  return totals;
}

export class ExploreUsageReader {
  private offset = 0;
  private inode: number | undefined;
  private totals: UsageTotals = { ...EMPTY_USAGE };

  reset(): void {
    this.totals = { ...EMPTY_USAGE };
    const file = getExploreUsageFile();
    try {
      const stat = statSync(file);
      this.inode = stat.ino;
      this.offset = stat.size;
    } catch {
      this.inode = undefined;
      this.offset = 0;
    }
  }

  readNewUsage(): UsageTotals {
    const file = getExploreUsageFile();
    let stat;
    try {
      stat = statSync(file);
    } catch {
      return { ...this.totals };
    }

    if (this.inode !== undefined && (stat.ino !== this.inode || stat.size < this.offset)) {
      this.offset = 0;
      this.totals = { ...EMPTY_USAGE };
    }
    this.inode = stat.ino;

    if (stat.size === this.offset) return { ...this.totals };

    const chunk = readFileSync(file, "utf8").slice(this.offset);
    this.offset = stat.size;
    for (const line of chunk.split("\n")) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        if (record?.type === "subagent_usage" && record?.subagent === "explore") {
          addUsage(this.totals, record.usage);
        }
      } catch {
        // Ignore partially written or malformed records.
      }
    }

    return { ...this.totals };
  }
}

export function formatUsageStats(usage: UsageTotals): string {
  const totalPrompt = usage.input + usage.cacheRead;
  const cacheHit = totalPrompt > 0 ? (usage.cacheRead / totalPrompt) * 100 : 0;
  const parts = [
    `↑${formatTokens(usage.input)}`,
    `↓${formatTokens(usage.output)}`,
    `R${formatTokens(usage.cacheRead)}`,
    `CH${cacheHit.toFixed(1)}%`,
    `$${usage.cost.toFixed(3)}`,
  ];
  return parts.join(" ");
}

const TAU_FOOTER_REFRESH_MS = 10_000;
const BLOCKED_TAU_STATES = new Set(["needs-input", "needs-permission"]);

function cwdBasename(cwd: string): string {
  return path.basename(cwd) || cwd;
}

export function formatTauFooterStatus(sessions: readonly TauDashboardSession[]): string {
  if (sessions.length === 0) return "";

  const blocked = sessions.find((session) => BLOCKED_TAU_STATES.has(session.state));
  const counts = new Map<string, number>();
  for (const session of sessions) counts.set(session.state, (counts.get(session.state) ?? 0) + 1);

  const summary = [
    "needs-input",
    "needs-permission",
    "working",
    "idle",
    "stale",
    "failed",
    "stopped",
  ]
    .map((state) => {
      const count = counts.get(state);
      return count ? `${state}:${count}` : "";
    })
    .filter(Boolean)
    .join(" ");

  if (blocked) return `Tau ${blocked.state} ${cwdBasename(blocked.cwd)} · ${summary}`;
  return `Tau ${summary}`;
}

export class TauFooterStatusReader {
  private status = "";
  private timer?: ReturnType<typeof setInterval>;
  private agentsDir: string;
  private loadSessions: (options: { agentsDir: string }) => Promise<LoadTauDashboardSessionsResult>;

  constructor(
    private requestRender: () => void,
    options: {
      agentsDir?: string;
      loadSessions?: (options: { agentsDir: string }) => Promise<LoadTauDashboardSessionsResult>;
    } = {},
  ) {
    this.agentsDir = options.agentsDir ?? getDefaultTauAgentsDir();
    this.loadSessions = options.loadSessions ?? loadTauDashboardSessions;
  }

  start(): void {
    this.stop();
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), TAU_FOOTER_REFRESH_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.status = "";
  }

  getStatus(): string {
    return this.status;
  }

  async refresh(): Promise<void> {
    try {
      const { sessions } = await this.loadSessions({ agentsDir: this.agentsDir });
      const next = formatTauFooterStatus(sessions);
      if (next !== this.status) {
        this.status = next;
        this.requestRender();
      }
    } catch {
      if (this.status) {
        this.status = "";
        this.requestRender();
      }
    }
  }
}

function sumUsage(a: UsageTotals, b: UsageTotals): UsageTotals {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    cost: a.cost + b.cost,
  };
}

function getThinkingLevel(ctx: ExtensionContext): string {
  for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
    if (entry.type === "thinking_level_change") return entry.thinkingLevel;
  }
  return "off";
}

type ContextUsageColorizer = (text: string, tokens: number | null | undefined) => string;

function colorizeContextUsage(theme: {
  fg(color: "warning" | "error", text: string): string;
  getFgAnsi(color: "dim"): string;
}): ContextUsageColorizer {
  return (text, tokens) => {
    if (typeof tokens !== "number" || !Number.isFinite(tokens)) return text;
    if (tokens >= 100_000) return theme.fg("error", text) + theme.getFgAnsi("dim");
    if (tokens >= 50_000) return theme.fg("warning", text) + theme.getFgAnsi("dim");
    return text;
  };
}

export function buildFooterLine(
  ctx: ExtensionContext,
  footerData: ReadonlyFooterDataProvider,
  exploreUsage: UsageTotals,
  width: number,
  colorContextUsage?: ContextUsageColorizer,
): string {
  const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "no-model";
  const thinking = getThinkingLevel(ctx);
  const usage = ctx.getContextUsage();
  const contextTokenCount = usage?.tokens;
  const contextTokens =
    contextTokenCount === null || contextTokenCount === undefined
      ? "?"
      : formatTokens(contextTokenCount);
  const coloredContextTokens = colorContextUsage
    ? colorContextUsage(contextTokens, contextTokenCount)
    : contextTokens;
  const contextLimit = formatTokens(usage?.contextWindow ?? ctx.model?.contextWindow ?? 0);
  const context = `${coloredContextTokens}/${contextLimit} ${formatPercent(usage?.percent)}`;
  const stats = formatUsageStats(sumUsage(getMainSessionUsage(ctx), exploreUsage));
  const left = `${model} ${thinking} · ${context} · ${stats}`;

  let right = shortenCwd(ctx.cwd);
  const branch = footerData.getGitBranch();
  if (branch) right = `${right} (${branch})`;

  const leftWidth = visibleWidth(left);
  const rightWidth = visibleWidth(right);
  if (leftWidth + 2 + rightWidth <= width) {
    return left + " ".repeat(width - leftWidth - rightWidth) + right;
  }

  if (leftWidth + 2 < width) {
    const truncatedRight = truncateToWidth(right, width - leftWidth - 2, "…");
    return (
      left +
      " ".repeat(Math.max(2, width - leftWidth - visibleWidth(truncatedRight))) +
      truncatedRight
    );
  }

  return truncateToWidth(left, width, "…");
}

class BitesFooter implements Component {
  private unsubscribe?: () => void;

  constructor(
    private ctx: ExtensionContext,
    private theme: any,
    private footerData: ReadonlyFooterDataProvider,
    private exploreUsageReader: ExploreUsageReader,
    private tauStatusReader: TauFooterStatusReader | undefined,
    private requestRender: () => void,
  ) {
    this.unsubscribe = footerData.onBranchChange(requestRender);
  }

  invalidate(): void {
    this.requestRender();
  }

  dispose(): void {
    this.unsubscribe?.();
    this.tauStatusReader?.stop();
  }

  render(width: number): string[] {
    const line = buildFooterLine(
      this.ctx,
      this.footerData,
      this.exploreUsageReader.readNewUsage(),
      width,
      colorizeContextUsage(this.theme),
    );
    const statuses = Array.from(this.footerData.getExtensionStatuses().entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, text]) =>
        String(text)
          .replace(/[\r\n\t]/g, " ")
          .replace(/ +/g, " ")
          .trim(),
      )
      .filter(Boolean);
    const tauStatus = this.tauStatusReader?.getStatus();
    if (tauStatus) statuses.unshift(tauStatus);

    const lines = [this.theme.fg("dim", line)];
    if (statuses.length > 0) {
      lines.push(truncateToWidth(statuses.join(" "), width, this.theme.fg("dim", "…")));
    }
    return lines;
  }
}

export default function registerFooter(
  pi: ExtensionAPI,
  options: { showTauStatus?: boolean } = {},
): void {
  const exploreUsageReader = new ExploreUsageReader();
  let tauStatusReader: TauFooterStatusReader | undefined;

  pi.on("session_start", async (_event, ctx) => {
    exploreUsageReader.reset();

    ctx.ui.setFooter((tui, theme, footerData) => {
      const requestRender = () => (tui as any).requestRender();
      tauStatusReader?.stop();
      tauStatusReader =
        options.showTauStatus === false ? undefined : new TauFooterStatusReader(requestRender);
      tauStatusReader?.start();
      return new BitesFooter(
        ctx,
        theme,
        footerData,
        exploreUsageReader,
        tauStatusReader,
        requestRender,
      );
    });
  });
}
