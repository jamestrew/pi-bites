import * as os from "node:os";
import * as path from "node:path";
import { readdirSync, readFileSync, statSync, watch, type FSWatcher } from "node:fs";
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { decodeSubagentUsageRecord, finiteNumberOrZero } from "../subagents/usage.js";

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

function getUsageDir(): string {
  return path.join(getAgentDir(), "pi-bites", "usage");
}

function getUsageFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const entryPath = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(entryPath);
        else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(entryPath);
      }
    } catch {
      // Missing/unreadable usage dirs are fine.
    }
  };
  walk(getUsageDir());
  files.sort();
  return files;
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

export type RepositoryStatus = { root?: string; jj?: string };

const JJ_ARGS = ["--ignore-working-copy", "--color", "never"];

async function runRepositoryCommand(
  pi: Pick<ExtensionAPI, "exec">,
  cwd: string,
  command: string,
  args: string[],
): Promise<string> {
  try {
    const result = await pi.exec(command, args, { cwd, timeout: 2_000 });
    return result.code === 0 ? result.stdout.trim() : "";
  } catch {
    return ""; // Missing executables and non-repository directories are fine.
  }
}

async function discoverRepository(
  pi: Pick<ExtensionAPI, "exec">,
  cwd: string,
): Promise<RepositoryStatus> {
  const root = await runRepositoryCommand(pi, cwd, "jj", [...JJ_ARGS, "root"]);
  if (root) return { root, jj: "jj" };
  return {
    root:
      (await runRepositoryCommand(pi, cwd, "git", ["rev-parse", "--show-toplevel"])) || undefined,
  };
}

export async function readRepositoryStatus(
  pi: Pick<ExtensionAPI, "exec">,
  cwd: string,
  repository?: RepositoryStatus,
): Promise<RepositoryStatus> {
  repository ??= await discoverRepository(pi, cwd);
  const { root } = repository;
  if (!root || !repository.jj) return repository;
  const run = (args: string[]) => runRepositoryCommand(pi, cwd, "jj", [...JJ_ARGS, ...args]);
  // Read-only queries must not snapshot the working copy or update colocated Git HEAD.
  const [change, bookmarks] = await Promise.all([
    run(["log", "--no-graph", "-r", "@", "-T", "change_id.shortest()"]),
    run([
      "log",
      "--no-graph",
      "-r",
      "heads(::@ & bookmarks())",
      "-T",
      'local_bookmarks.map(|b| b.name()).join(", ") ++ "\\n"',
    ]),
  ]);
  // At merges, keep each nearest bookmarked ancestor rather than guessing a branch.
  const names = bookmarks.split("\n").filter(Boolean).join(", ");
  return { root, jj: `jj${change ? `: ${change}` : ""}${names ? ` · ${names}` : ""}` };
}

export function watchJjMetadata(root: string, onChange: () => void): () => void {
  let repo = path.join(root, ".jj", "repo");
  try {
    if (statSync(repo).isFile()) {
      // Additional workspaces store a relative path to the shared repository.
      repo = path.resolve(root, ".jj", readFileSync(repo, "utf8").trim());
    }
  } catch {
    // Metadata may disappear between root discovery and watcher setup.
  }
  let heads = path.join(repo, "op_heads");
  try {
    if (statSync(path.join(heads, "heads")).isDirectory()) heads = path.join(heads, "heads");
  } catch {
    // Older jj versions store head entries directly in op_heads.
  }
  const checkout = path.join(root, ".jj", "working_copy", "checkout");
  const fingerprint = () => {
    try {
      const operations = readdirSync(heads)
        .filter((name) => /^[0-9a-f]+$/.test(name))
        .sort();
      return operations.join(",") + ":" + readFileSync(checkout).toString("hex");
    } catch {
      return undefined; // Keep the cached status while metadata is temporarily unavailable.
    }
  };
  let previous = fingerprint();
  let disposed = false;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let fallback: ReturnType<typeof setInterval> | undefined;
  const watchers: FSWatcher[] = [];
  const check = () => {
    if (disposed) return;
    const next = fingerprint();
    if (next === undefined || next === previous) return;
    previous = next;
    onChange();
  };
  const schedule = () => {
    if (disposed) return;
    clearTimeout(debounce);
    debounce = setTimeout(check, 500);
    debounce.unref();
  };
  const pollMetadata = () => {
    // If native watching fails, poll only this small fingerprint—not jj commands.
    fallback ??= setInterval(check, 5_000);
    fallback.unref();
  };
  for (const directory of [heads, path.dirname(checkout)]) {
    try {
      const watcher = watch(directory, { persistent: false }, schedule);
      watcher.on("error", () => {
        watcher.close();
        if (!disposed) pollMetadata();
      });
      watchers.push(watcher);
    } catch {
      pollMetadata();
    }
  }
  // Cover changes between the first fingerprint and watcher installation.
  schedule();
  return () => {
    disposed = true;
    clearTimeout(debounce);
    clearInterval(fallback);
    for (const watcher of watchers) watcher.close();
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function addUsage(target: UsageTotals, usage: unknown): void {
  if (!isRecord(usage)) return;
  target.input += finiteNumberOrZero(usage.input);
  target.output += finiteNumberOrZero(usage.output);
  target.cacheRead += finiteNumberOrZero(usage.cacheRead);
  target.cacheWrite += finiteNumberOrZero(usage.cacheWrite);
  target.cost += finiteNumberOrZero(isRecord(usage.cost) ? usage.cost.total : usage.cost);
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

export class SubagentUsageReader {
  private files = new Map<string, { offset: number; inode: number }>();
  private totals: UsageTotals = { ...EMPTY_USAGE };

  constructor(private parentSessionId: string) {}

  readNewUsage(): UsageTotals {
    for (const file of getUsageFiles()) {
      let stat;
      try {
        stat = statSync(file);
      } catch {
        continue;
      }

      let state = this.files.get(file);
      if (!state || state.inode !== stat.ino || stat.size < state.offset) {
        state = { inode: stat.ino, offset: 0 };
        this.files.set(file, state);
      }
      if (stat.size === state.offset) continue;

      const chunk = readFileSync(file, "utf8").slice(state.offset);
      state.offset = stat.size;
      for (const line of chunk.split("\n")) {
        if (!line.trim()) continue;
        try {
          const record = decodeSubagentUsageRecord(JSON.parse(line));
          if (record?.parentSessionId === this.parentSessionId) {
            addUsage(this.totals, record.usage);
          }
        } catch {
          // Ignore partially written or malformed records.
        }
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
  repository: RepositoryStatus = {},
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

  let right = repository.root
    ? path.join(path.basename(repository.root), path.relative(repository.root, ctx.cwd))
    : path.basename(ctx.cwd) || ctx.cwd;
  const branch = repository.jj ?? footerData.getGitBranch();
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

function cleanStatusText(text: string): string {
  return String(text)
    .replace(/[\r\n\t]/g, " ")
    .replace(/ +/g, " ")
    .trim();
}

export function buildExtensionStatusLines(
  statuses: ReadonlyMap<string, string>,
  width: number,
  ellipsis = "…",
): string[] {
  const entries = Array.from(statuses.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, text]) => [id, cleanStatusText(text)] as const)
    .filter(([, text]) => text);

  const lines: string[] = [];
  const inlineStatuses = entries.filter(([id]) => id !== "session-tracker").map(([, text]) => text);
  if (inlineStatuses.length > 0)
    lines.push(truncateToWidth(inlineStatuses.join(" "), width, ellipsis));

  const sessionTracker = entries.find(([id]) => id === "session-tracker")?.[1];
  if (sessionTracker) lines.push(truncateToWidth(sessionTracker, width, ellipsis));

  return lines;
}

class BitesFooter implements Component {
  private unsubscribe?: () => void;
  private stopWatching?: () => void;
  private repository: RepositoryStatus = {};
  private pending = false;
  private refreshAgain = false;
  private disposed = false;

  constructor(
    private ctx: ExtensionContext,
    private theme: Theme,
    private footerData: ReadonlyFooterDataProvider,
    private subagentUsageReader: SubagentUsageReader,
    private requestRender: () => void,
    private pi: ExtensionAPI,
    private cwd: string,
  ) {
    this.unsubscribe = footerData.onBranchChange(requestRender);
    void this.initializeRepository();
  }

  private async initializeRepository(): Promise<void> {
    const repository = await discoverRepository(this.pi, this.cwd);
    if (this.disposed) return;
    if (repository.root && repository.jj) {
      this.stopWatching = watchJjMetadata(repository.root, () => void this.refreshRepository());
    }
    await this.refreshRepository(repository);
  }

  private async refreshRepository(repository = this.repository): Promise<void> {
    if (this.disposed) return;
    if (this.pending) {
      this.refreshAgain = true;
      return;
    }
    this.pending = true;
    try {
      const updated = await readRepositoryStatus(this.pi, this.cwd, repository);
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- dispose() can run during await.
      if (this.disposed) return;
      if (updated.root !== this.repository.root || updated.jj !== this.repository.jj) {
        this.repository = updated;
        this.requestRender();
      }
    } finally {
      this.pending = false;
      if (this.refreshAgain) {
        this.refreshAgain = false;
        void this.refreshRepository();
      }
    }
  }

  invalidate(): void {
    this.requestRender();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopWatching?.();
    this.unsubscribe?.();
  }

  render(width: number): string[] {
    // Pi disposes the footer before invalidating its ctx; only live renders may use it.
    if (this.disposed) return [];
    const line = buildFooterLine(
      this.ctx,
      this.footerData,
      this.subagentUsageReader.readNewUsage(),
      width,
      colorizeContextUsage(this.theme),
      this.repository,
    );
    return [
      this.theme.fg("dim", line),
      ...buildExtensionStatusLines(
        this.footerData.getExtensionStatuses(),
        width,
        this.theme.fg("dim", "…"),
      ),
    ];
  }
}

export default function registerFooter(pi: ExtensionAPI): void {
  let footer: BitesFooter | undefined;
  pi.on("session_shutdown", () => {
    footer?.dispose();
    footer = undefined;
  });
  pi.on("session_start", (_event, ctx) => {
    footer?.dispose();
    footer = undefined;
    const cwd = ctx.cwd;
    const subagentUsageReader = new SubagentUsageReader(ctx.sessionManager.getSessionId());

    ctx.ui.setFooter((tui, theme, footerData) => {
      footer = new BitesFooter(
        ctx,
        theme,
        footerData,
        subagentUsageReader,
        () => tui.requestRender(),
        pi,
        cwd,
      );
      return footer;
    });
  });
}
