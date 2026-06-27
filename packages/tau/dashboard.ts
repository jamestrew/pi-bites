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
  selectedSessionId?: string;
  showHelp?: boolean;
}

export type TauDashboardRowKind = "chrome" | "header" | "session" | "empty";

export interface TauDashboardRow {
  kind: TauDashboardRowKind;
  line: string;
  sessionId?: string;
}

export interface TauDashboardViewModel {
  title: string;
  lines: string[];
  rows: TauDashboardRow[];
  selectableSessionIds: string[];
}

export interface TauDashboardSelectionState {
  selectedSessionId?: string;
  selectedIndex: number;
}

export interface ReconcileTauDashboardSelectionOptions {
  previousSessionId?: string;
  previousIndex?: number;
}

export interface TauDashboardControllerState {
  sessions: readonly TauDashboardSession[];
  selection: TauDashboardSelectionState;
  showHelp: boolean;
  quitting: boolean;
}

export type TauDashboardControllerEffect = "render" | "refresh" | "open" | "quit";

export interface TauDashboardControllerResult {
  state: TauDashboardControllerState;
  effect?: TauDashboardControllerEffect;
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
  if (!session.sessionFileExists) return "missing session file";
  if ((session.state === "failed" || session.sourceStatus === "failed") && session.lastError)
    return session.lastError;
  if (session.state === "stopped") return "stopped";
  if (session.state === "stale") return "stale";
  if (session.currentAction && session.currentTool) {
    return `${session.currentAction} · ${session.currentTool}`;
  }
  return session.currentAction || session.currentTool || session.lastError || "observing";
}

function renderRow(session: TauDashboardSession, now: number, selected: boolean): string {
  const cwd = compactPath(session.cwd);
  const age = formatAge(now - session.activityAt);
  const marker = selected ? "›" : " ";
  return `${marker} • ${sessionLabel(session)} — ${actionLabel(session)} · ${cwd} · ${age}`;
}

function summarizeIssues(issues: readonly TauStatusLoadIssue[]): string | undefined {
  if (issues.length === 0) return undefined;
  const counts = new Map<string, number>();
  for (const issue of issues) counts.set(issue.kind, (counts.get(issue.kind) ?? 0) + 1);
  const summary = [...counts.entries()].map(([kind, count]) => `${count} ${kind}`).join(", ");
  return `Warning: skipped ${issues.length} Tau status record${issues.length === 1 ? "" : "s"} (${summary}).`;
}

export function reconcileTauDashboardSelection(
  sessions: readonly TauDashboardSession[],
  options: ReconcileTauDashboardSelectionOptions = {},
): TauDashboardSelectionState {
  if (sessions.length === 0) return { selectedIndex: -1 };

  const existingIndex = options.previousSessionId
    ? sessions.findIndex((session) => session.sessionId === options.previousSessionId)
    : -1;
  const selectedIndex =
    existingIndex >= 0
      ? existingIndex
      : Math.min(Math.max(options.previousIndex ?? 0, 0), sessions.length - 1);

  return { selectedSessionId: sessions[selectedIndex]?.sessionId, selectedIndex };
}

export function moveTauDashboardSelection(
  sessions: readonly TauDashboardSession[],
  state: TauDashboardSelectionState,
  delta: number,
): TauDashboardSelectionState {
  if (sessions.length === 0) return { selectedIndex: -1 };
  const currentIndex = state.selectedSessionId
    ? sessions.findIndex((session) => session.sessionId === state.selectedSessionId)
    : state.selectedIndex;
  const selectedIndex = Math.min(
    Math.max((currentIndex >= 0 ? currentIndex : 0) + delta, 0),
    sessions.length - 1,
  );
  return { selectedSessionId: sessions[selectedIndex]?.sessionId, selectedIndex };
}

function pushRow(rows: TauDashboardRow[], row: TauDashboardRow): void {
  rows.push(row);
}

export function handleTauDashboardKey(
  state: TauDashboardControllerState,
  key: string,
): TauDashboardControllerResult {
  if (state.quitting) return { state };

  switch (key) {
    case "up":
    case "k":
      return {
        state: {
          ...state,
          selection: moveTauDashboardSelection(state.sessions, state.selection, -1),
        },
        effect: "render",
      };
    case "down":
    case "j":
      return {
        state: {
          ...state,
          selection: moveTauDashboardSelection(state.sessions, state.selection, 1),
        },
        effect: "render",
      };
    case "r":
      return { state, effect: "refresh" };
    case "?":
      return { state: { ...state, showHelp: !state.showHelp }, effect: "render" };
    case "return":
    case "enter":
      return { state, effect: state.selection.selectedSessionId ? "open" : "render" };
    case "q":
      return { state: { ...state, quitting: true }, effect: "quit" };
    default:
      return { state };
  }
}

export function buildTauDashboardView(
  sessions: readonly TauDashboardSession[],
  issues: readonly TauStatusLoadIssue[] = [],
  options: RenderTauDashboardOptions = {},
): TauDashboardViewModel {
  const now = options.now ?? Date.now();
  const rows: TauDashboardRow[] = [];
  pushRow(rows, { kind: "chrome", line: TAU_DASHBOARD_TITLE });
  pushRow(rows, { kind: "chrome", line: PRODUCT_BOUNDARY_COPY });
  pushRow(rows, { kind: "chrome", line: "" });
  const warning = summarizeIssues(issues);
  if (warning) {
    pushRow(rows, { kind: "chrome", line: warning });
    pushRow(rows, { kind: "chrome", line: "" });
  }

  if (sessions.length === 0) {
    pushRow(rows, { kind: "empty", line: EMPTY_STATE_COPY });
  } else {
    const byState = new Map<TauStatusValue, TauDashboardSession[]>();
    for (const session of sessions) {
      const bucket = byState.get(session.state) ?? [];
      bucket.push(session);
      byState.set(session.state, bucket);
    }

    for (const state of GROUP_ORDER) {
      const group = byState.get(state) ?? [];
      pushRow(rows, { kind: "header", line: `${GROUP_LABELS[state]} (${group.length})` });
      if (group.length === 0) {
        pushRow(rows, { kind: "empty", line: "  none" });
      } else {
        for (const session of group) {
          pushRow(rows, {
            kind: "session",
            line: renderRow(session, now, session.sessionId === options.selectedSessionId),
            sessionId: session.sessionId,
          });
        }
      }
      pushRow(rows, { kind: "chrome", line: "" });
    }
    rows.pop();
  }

  pushRow(rows, { kind: "chrome", line: "" });
  pushRow(rows, { kind: "chrome", line: "enter open · r refresh · q quit · ? help" });
  if (options.showHelp) {
    pushRow(rows, { kind: "chrome", line: "" });
    pushRow(rows, {
      kind: "chrome",
      line: "Help: ↑/↓ or j/k move selection; Enter opens the selected session in native pi; r refreshes; q quits; ? toggles help.",
    });
  }

  const lines = rows.map((row) => row.line);
  return {
    title: TAU_DASHBOARD_TITLE,
    lines,
    rows,
    selectableSessionIds: sessions.map((session) => session.sessionId),
  };
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
