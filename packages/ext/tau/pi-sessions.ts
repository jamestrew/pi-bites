import { Container, Spacer, Text, getKeybindings } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  getTrackerSocketPath,
  requestTracker,
  type PaneRecord,
} from "../../session-tracker/index.js";
import type { TauDashboardSession, TauStatusValue } from "../../tau/index.js";
import { WrappingSelect, type WrappingSelectItem } from "../question/wrapping-select.js";
import { orderPiSessions, piSessionLabel } from "./pi-sessions-model.js";

const MAX_VISIBLE_ROWS = 12;
const NAV_HINT = "Enter to select · ↑/↓ to navigate · Esc to cancel";
const EMPTY_MESSAGE = "No tracked Pi sessions yet.";
const UNAVAILABLE_MESSAGE = "Pi sessions snapshot is unavailable.";

export type PiSessionsSnapshotFetcher = () => Promise<readonly PaneRecord[]>;

export async function fetchPiSessionsSnapshot(): Promise<readonly PaneRecord[]> {
  const response = await requestTracker(getTrackerSocketPath(), { type: "snapshot" });
  if (!response.ok) throw new Error(response.error ?? "tracker snapshot failed");
  return response.records ?? [];
}

function toTauState(state: PaneRecord["state"]): TauStatusValue {
  return state === "needs-permission" ? "needs-permission" : state;
}

export function paneRecordToPiSession(record: PaneRecord): TauDashboardSession {
  const state = toTauState(record.state);
  return {
    sessionId: record.sessionId ?? record.paneId,
    sessionFile: record.sessionId ?? "",
    cwd: record.cwd,
    pid: 0,
    startedAt: record.heartbeatAt,
    heartbeatAt: record.heartbeatAt,
    lastEventAt: record.heartbeatAt,
    activityAt: record.heartbeatAt,
    sourceStatus: state,
    state,
    isLive: true,
    isStale: false,
    sessionFileExists: Boolean(record.sessionId),
    statusFile: record.paneId,
    title: record.paneId,
  };
}

function toItem(
  session: TauDashboardSession,
): WrappingSelectItem & { session: TauDashboardSession } {
  return {
    label: piSessionLabel(session),
    description: session.currentAction || session.lastMessage || session.sessionId,
    session,
  };
}

function wrapIndex(index: number, length: number): number {
  return ((index % length) + length) % length;
}

async function pickPiSession(
  ctx: Parameters<Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]>[1],
  sessions: readonly TauDashboardSession[],
): Promise<TauDashboardSession | null> {
  const items = orderPiSessions(sessions).map(toItem);
  let selectionIndex = 0;

  return ctx.ui.custom<TauDashboardSession | null>((tui, theme, _kb, done) => {
    const list = new WrappingSelect(items, Math.min(items.length, MAX_VISIBLE_ROWS), {
      selectedText: (text) => theme.fg("accent", theme.bold(text)),
      description: (text) => theme.fg("muted", text),
      scrollInfo: (text) => theme.fg("dim", text),
    });
    const container = new Container();
    container.addChild(new Text(theme.bold("Pi sessions"), 1, 0));
    container.addChild(new Text(theme.fg("dim", NAV_HINT), 1, 0));
    container.addChild(new Spacer(1));
    container.addChild(list);

    return {
      render: (width) => container.render(width),
      invalidate: () => {},
      handleInput: (data) => {
        const kb = getKeybindings();
        if (kb.matches(data, "tui.select.up")) {
          selectionIndex = wrapIndex(selectionIndex - 1, items.length);
          list.setSelectedIndex(selectionIndex);
          tui.requestRender();
          return;
        }
        if (kb.matches(data, "tui.select.down")) {
          selectionIndex = wrapIndex(selectionIndex + 1, items.length);
          list.setSelectedIndex(selectionIndex);
          tui.requestRender();
          return;
        }
        if (kb.matches(data, "tui.select.confirm")) {
          done(items[selectionIndex]?.session ?? null);
          return;
        }
        if (kb.matches(data, "tui.select.cancel")) done(null);
      },
    };
  });
}

export async function handlePiSessionsCommand(
  ctx: Parameters<Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]>[1],
  fetchSnapshot: PiSessionsSnapshotFetcher = fetchPiSessionsSnapshot,
): Promise<void> {
  let records: readonly PaneRecord[];
  try {
    records = await fetchSnapshot();
  } catch {
    ctx.ui.notify(UNAVAILABLE_MESSAGE, "info");
    return;
  }

  if (records.length === 0) {
    ctx.ui.notify(EMPTY_MESSAGE, "info");
    return;
  }

  const selected = await pickPiSession(ctx, records.map(paneRecordToPiSession));
  if (selected) ctx.ui.notify(`Selected ${piSessionLabel(selected)}`, "info");
}
