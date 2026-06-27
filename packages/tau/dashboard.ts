import { Container, Spacer, Text, truncateToWidth } from "@earendil-works/pi-tui";

import type { TauDashboardSession, TauStatusLoadIssue, TauStatusValue } from "./index.js";

export const TAU_DASHBOARD_TITLE = "Tau · Pi agents dashboard";

const PRODUCT_BOUNDARY_COPY =
  "Tau observes sidecar status and opens sessions; native pi remains the session UI.";
const EMPTY_STATE_COPY =
  "No Tau sidecar statuses were found yet. Start pi with Tau enabled to populate ~/.pi/agents/sessions.";

const GROUP_ORDER = [
  "working",
  "needs-permission",
  "needs-input",
  "failed",
  "idle",
  "stopped",
  "stale",
] as const satisfies readonly TauStatusValue[];

const GROUP_LABELS: Record<TauStatusValue, string> = {
  working: "Working",
  "needs-permission": "Needs permission",
  "needs-input": "Needs input",
  failed: "Failed",
  idle: "Idle",
  stopped: "Stopped",
  stale: "Stale",
};

export interface RenderTauDashboardOptions {
  now?: number;
  width?: number;
}

export interface TauDashboardViewModel {
  title: string;
  lines: string[];
}

function formatAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const seconds = Math.floor(ms / 1_000);
  if (seconds < 60) return seconds <= 5 ? "just now" : `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function compactPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.at(-1) ?? path;
}

function sessionLabel(session: TauDashboardSession): string {
  return session.title?.trim() || session.sessionId;
}

function actionLabel(session: TauDashboardSession): string {
  if (session.currentAction && session.currentTool) {
    return `${session.currentAction} · ${session.currentTool}`;
  }
  return session.currentAction || session.currentTool || session.lastError || "observing";
}

function renderRow(session: TauDashboardSession, now: number): string {
  const cwd = compactPath(session.cwd);
  const age = formatAge(now - session.activityAt);
  return `  • ${sessionLabel(session)} — ${actionLabel(session)} · ${cwd} · ${age}`;
}

function summarizeIssues(issues: readonly TauStatusLoadIssue[]): string | undefined {
  if (issues.length === 0) return undefined;
  const counts = new Map<string, number>();
  for (const issue of issues) counts.set(issue.kind, (counts.get(issue.kind) ?? 0) + 1);
  const summary = [...counts.entries()].map(([kind, count]) => `${count} ${kind}`).join(", ");
  return `Warning: skipped ${issues.length} Tau status record${issues.length === 1 ? "" : "s"} (${summary}).`;
}

export function buildTauDashboardView(
  sessions: readonly TauDashboardSession[],
  issues: readonly TauStatusLoadIssue[] = [],
  options: RenderTauDashboardOptions = {},
): TauDashboardViewModel {
  const now = options.now ?? Date.now();
  const lines: string[] = [TAU_DASHBOARD_TITLE, PRODUCT_BOUNDARY_COPY, ""];
  const warning = summarizeIssues(issues);
  if (warning) lines.push(warning, "");

  if (sessions.length === 0) {
    lines.push(EMPTY_STATE_COPY);
    return { title: TAU_DASHBOARD_TITLE, lines };
  }

  const byState = new Map<TauStatusValue, TauDashboardSession[]>();
  for (const session of sessions) {
    const bucket = byState.get(session.state) ?? [];
    bucket.push(session);
    byState.set(session.state, bucket);
  }

  for (const state of GROUP_ORDER) {
    const group = byState.get(state) ?? [];
    lines.push(`${GROUP_LABELS[state]} (${group.length})`);
    if (group.length === 0) {
      lines.push("  none");
    } else {
      for (const session of group) lines.push(renderRow(session, now));
    }
    lines.push("");
  }

  return { title: TAU_DASHBOARD_TITLE, lines: lines.slice(0, -1) };
}

export function renderTauDashboard(
  sessions: readonly TauDashboardSession[],
  issues: readonly TauStatusLoadIssue[] = [],
  options: RenderTauDashboardOptions = {},
): string[] {
  const width = options.width ?? 100;
  const view = buildTauDashboardView(sessions, issues, options);
  const container = new Container();
  for (const line of view.lines) {
    if (line === "") container.addChild(new Spacer(1));
    else container.addChild(new Text(truncateToWidth(line, width), 0, 0));
  }
  return container.render(width).map((line) => line.trimEnd());
}
