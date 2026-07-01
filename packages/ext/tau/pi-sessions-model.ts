import { basename } from "node:path";

import type { TauDashboardSession, TauStatusValue } from "../../tau/index.js";

const STATE_RANK: Record<TauStatusValue, number> = {
  blocked: 0,
  "needs-permission": 0,
  "needs-input": 0,
  failed: 0,
  working: 1,
  idle: 2,
  stopped: 3,
  stale: 3,
};

export function orderPiSessions(sessions: readonly TauDashboardSession[]): TauDashboardSession[] {
  return [...sessions].sort(
    (a, b) =>
      STATE_RANK[a.state] - STATE_RANK[b.state] ||
      b.activityAt - a.activityAt ||
      a.sessionId.localeCompare(b.sessionId),
  );
}

export function piSessionLabel(session: TauDashboardSession): string {
  const cwd = basename(session.cwd) || session.cwd;
  const title = session.title?.trim() || session.sessionId;
  return `${cwd} · ${session.state} · ${title}`;
}
