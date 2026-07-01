import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { basename } from "node:path";
import {
  getTrackerSocketPath,
  requestTracker,
  spawnSessionTrackerDaemon,
  TRACKER_HEARTBEAT_INTERVAL_MS,
  type PaneRecord,
  type TrackerRequest,
  type TrackerResponse,
  type TrackerState,
} from "../../session-tracker/index.js";

interface TrackerContext {
  cwd: string;
  sessionManager?: { getSessionId?: () => string };
}

export interface TrackerRuntimeOptions {
  runtimeId?: string;
  paneId?: string;
  socketPath?: string;
  heartbeatIntervalMs?: number;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  send?: typeof requestTracker;
  spawnDaemon?: typeof spawnSessionTrackerDaemon;
  now?: () => number;
}

export interface TrackerFooterOptions {
  socketPath?: string;
  intervalMs?: number;
  paneId?: string;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  send?: typeof requestTracker;
}

const STATE_ORDER: Record<TrackerState, number> = { "needs-permission": 0, working: 1, idle: 2 };
export const SESSION_TRACKER_FOOTER_INTERVAL_MS = 1_000;

export function sortPaneRecordsForPicker(records: readonly PaneRecord[]): PaneRecord[] {
  return [...records].sort(
    (a, b) =>
      STATE_ORDER[a.state] - STATE_ORDER[b.state] ||
      basename(a.cwd).localeCompare(basename(b.cwd)) ||
      a.paneId.localeCompare(b.paneId),
  );
}

export function formatPaneRecordLabel(record: PaneRecord): string {
  return `${record.state} · ${basename(record.cwd) || record.cwd} · ${record.paneId}`;
}

export function formatSessionTrackerFooter(
  records: readonly PaneRecord[],
  focusedPaneId?: string,
): string | undefined {
  if (records.length === 0) return undefined;

  const counts = { idle: 0, working: 0, "needs-permission": 0 } satisfies Record<
    TrackerState,
    number
  >;
  for (const record of records) {
    if (record.state === "needs-permission" && record.paneId === focusedPaneId) continue;
    counts[record.state]++;
  }

  const blocked = sortPaneRecordsForPicker(records).find(
    (record) => record.state === "needs-permission" && record.paneId !== focusedPaneId,
  );
  const blockedName = blocked ? basename(blocked.cwd) || blocked.cwd : "?";
  const parts = [
    `pi-sessions: ${records.length}`,
    counts["needs-permission"]
      ? `blocked ${blockedName}${counts["needs-permission"] > 1 ? ` +${counts["needs-permission"] - 1}` : ""}`
      : undefined,
    counts.working ? `${counts.working} working` : undefined,
    counts.idle ? `${counts.idle} idle` : undefined,
  ].filter(Boolean);

  return parts.join(" · ");
}

export function colorizeSessionTrackerFooter(
  text: string | undefined,
  theme?: {
    fg(color: "dim" | "warning" | "error", text: string): string;
    getFgAnsi?(color: "dim"): string;
  },
): string | undefined {
  if (!text || !theme) return text;
  const blocked = text.match(/blocked [^·]+/);
  if (blocked?.index === undefined) return theme.fg("dim", text);
  const blockedText = blocked[0].trimEnd();
  return (
    theme.fg("dim", text.slice(0, blocked.index)) +
    theme.fg("error", blockedText) +
    (theme.getFgAnsi?.("dim") ?? "") +
    theme.fg("dim", text.slice(blocked.index + blockedText.length))
  );
}

export async function requestSessionTracker(
  socketPath: string,
  request: TrackerRequest,
  options: Pick<TrackerRuntimeOptions, "send" | "spawnDaemon"> = {},
): Promise<TrackerResponse> {
  const send = options.send ?? requestTracker;
  const spawnDaemon = options.spawnDaemon ?? spawnSessionTrackerDaemon;
  try {
    return await send(socketPath, request);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ECONNREFUSED") throw error;
    spawnDaemon();
    if (!options.send) {
      for (let i = 0; i < 20 && !existsSync(socketPath); i++)
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return send(socketPath, request);
  }
}

interface PiSessionsPickerContext {
  ui: {
    notify(message: string, level: "info" | "warning" | "error"): void;
    select(title: string, choices: string[]): Promise<string | undefined>;
  };
}

export async function runPiSessionsPicker(
  ctx: PiSessionsPickerContext,
  options: Pick<TrackerRuntimeOptions, "socketPath" | "send" | "spawnDaemon"> = {},
): Promise<void> {
  const socketPath = options.socketPath ?? getTrackerSocketPath();
  let records: PaneRecord[];
  try {
    const snapshot = await requestSessionTracker(socketPath, { type: "snapshot" }, options);
    records = sortPaneRecordsForPicker(snapshot.records ?? []);
  } catch {
    ctx.ui.notify("Pi sessions are unavailable.", "warning");
    return;
  }
  if (records.length === 0) {
    ctx.ui.notify("No tracked Pi sessions.", "info");
    return;
  }

  const labels = records.map(formatPaneRecordLabel);
  const selected = await ctx.ui.select("Pi sessions", labels);
  const record = records[labels.indexOf(selected ?? "")];
  if (!record) return;

  let response: TrackerResponse;
  try {
    response = await requestSessionTracker(
      socketPath,
      { type: "focus_pane", paneId: record.paneId },
      options,
    );
  } catch {
    ctx.ui.notify("Pi sessions are unavailable.", "warning");
    return;
  }
  if (!response.ok) {
    ctx.ui.notify(
      response.error === "not-found"
        ? "That tmux pane disappeared. Refresh and try again."
        : `Failed to focus tmux pane: ${response.error ?? "unknown error"}`,
      response.error === "not-found" ? "warning" : "error",
    );
  }
}

export function createSessionTrackerFooterRuntime(options: TrackerFooterOptions = {}) {
  const socketPath = options.socketPath ?? getTrackerSocketPath();
  const intervalMs = options.intervalMs ?? SESSION_TRACKER_FOOTER_INTERVAL_MS;
  const setTimer = options.setInterval ?? setInterval;
  const clearTimer = options.clearInterval ?? clearInterval;
  const send = options.send ?? requestTracker;
  const paneId = options.paneId ?? process.env.TMUX_PANE;
  let timer: ReturnType<typeof setInterval> | undefined;

  return {
    start(
      ctx: TrackerContext & {
        ui: { setStatus(id: string, text: string | undefined): void; theme?: any };
      },
    ) {
      const update = async () => {
        try {
          const response = await send(socketPath, { type: "snapshot" });
          ctx.ui.setStatus(
            "session-tracker",
            colorizeSessionTrackerFooter(
              formatSessionTrackerFooter(response.records ?? [], paneId),
              ctx.ui.theme,
            ),
          );
        } catch {
          ctx.ui.setStatus("session-tracker", undefined);
        }
      };
      void update();
      timer = setTimer(() => void update(), intervalMs);
      timer.unref?.();
    },
    stop(ctx?: { ui?: { setStatus(id: string, text: string | undefined): void } }) {
      if (timer) clearTimer(timer);
      timer = undefined;
      ctx?.ui?.setStatus("session-tracker", undefined);
    },
  };
}

export function createSessionTrackerRuntime(options: TrackerRuntimeOptions = {}) {
  const runtimeId = options.runtimeId ?? randomUUID();
  const paneId = options.paneId ?? process.env.TMUX_PANE;
  const socketPath = options.socketPath ?? getTrackerSocketPath();
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? TRACKER_HEARTBEAT_INTERVAL_MS;
  const setTimer = options.setInterval ?? setInterval;
  const clearTimer = options.clearInterval ?? clearInterval;
  const now = options.now ?? Date.now;
  let seq = 0;
  let state: TrackerState = "idle";
  let ctx: TrackerContext | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;

  const record = (): PaneRecord | undefined => {
    if (!paneId || !ctx) return undefined;
    const sessionId = ctx.sessionManager?.getSessionId?.();
    return {
      paneId,
      cwd: ctx.cwd,
      runtimeId,
      seq: ++seq,
      state,
      heartbeatAt: now(),
      ...(sessionId ? { sessionId } : {}),
    };
  };

  const call = (request: TrackerRequest) => requestSessionTracker(socketPath, request, options);

  const report = async (type: "report" | "heartbeat") => {
    const current = record();
    if (current) await call({ type, record: current });
  };

  return {
    async start(startCtx: TrackerContext) {
      ctx = startCtx;
      await report("report");
      timer = setTimer(() => void report("heartbeat"), heartbeatIntervalMs);
      timer.unref?.();
    },
    async setState(next: TrackerState) {
      state = next;
      await report("report");
    },
    async stop(release = false) {
      if (timer) clearTimer(timer);
      timer = undefined;
      if (release && paneId) await call({ type: "release", paneId, runtimeId });
      ctx = undefined;
    },
  };
}

export default function registerSessionTracker(pi: ExtensionAPI): void {
  const runtime = createSessionTrackerRuntime();
  const footerRuntime = createSessionTrackerFooterRuntime();
  let currentCtx:
    | (TrackerContext & { ui: { setStatus(id: string, text: string | undefined): void } })
    | undefined;
  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;
    await runtime.start(ctx);
    footerRuntime.start(ctx);
  });
  pi.on("agent_start", async () => runtime.setState("working"));
  pi.events?.on("bites:bash_gate", async () => runtime.setState("needs-permission"));
  pi.events?.on("bites:bash_gate_resolved", async () => runtime.setState("working"));
  pi.on("agent_end", async () => runtime.setState("idle"));
  pi.on("turn_end", async () => runtime.setState("idle"));
  pi.on("session_shutdown", async (event) => {
    footerRuntime.stop(currentCtx);
    currentCtx = undefined;
    await runtime.stop(event.reason === "quit");
  });

  pi.registerCommand("pi-sessions", {
    description: "Pick a tracked Pi tmux pane to focus",
    handler: async (_args, ctx) => runPiSessionsPicker(ctx),
  });
}
