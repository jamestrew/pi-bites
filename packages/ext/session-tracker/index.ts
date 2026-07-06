import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { basename } from "node:path";
import {
  getTrackerSocketPath,
  requestTracker,
  spawnSessionTrackerDaemon,
  writeSessionTrackerLog,
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
  runtimeId: string;
  paneId?: string;
  socketPath: string;
  heartbeatIntervalMs: number;
  setInterval: typeof setInterval;
  clearInterval: typeof clearInterval;
  send: typeof requestTracker;
  spawnDaemon: typeof spawnSessionTrackerDaemon;
  awaitDaemonReady: (socketPath: string) => Promise<void>;
  log: typeof writeSessionTrackerLog;
  now: () => number;
}

export interface TrackerFooterOptions {
  socketPath: string;
  intervalMs: number;
  paneId?: string;
  setInterval: typeof setInterval;
  clearInterval: typeof clearInterval;
  send: typeof requestTracker;
  log: typeof writeSessionTrackerLog;
}

const STATE_ORDER: Record<TrackerState, number> = { "needs-permission": 0, working: 1, idle: 2 };
export const SESSION_TRACKER_FOOTER_INTERVAL_MS = 1_000;
const DAEMON_READY_MAX_ATTEMPTS = 100;
const DAEMON_READY_POLL_INTERVAL_MS = 50;
const DAEMON_START_FAILURE_COOLDOWN_MS = 60_000;

function isSocketUnavailableError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ECONNREFUSED";
}

function probeTrackerSocket(socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    socket.on("connect", () => {
      socket.destroy();
      resolve();
    });
    socket.on("error", reject);
  });
}

async function awaitTrackerSocket(socketPath: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await probeTrackerSocket(socketPath);
    } catch (error) {
      if (!isSocketUnavailableError(error) || attempt >= DAEMON_READY_MAX_ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, DAEMON_READY_POLL_INTERVAL_MS));
    }
  }
}

export const defaultTrackerRuntimeOptions: Omit<TrackerRuntimeOptions, "runtimeId" | "socketPath"> =
  {
    heartbeatIntervalMs: TRACKER_HEARTBEAT_INTERVAL_MS,
    setInterval,
    clearInterval,
    now: Date.now,
    send: requestTracker,
    spawnDaemon: spawnSessionTrackerDaemon,
    awaitDaemonReady: awaitTrackerSocket,
    log: writeSessionTrackerLog,
  };

export const defaultTrackerFooterOptions: Omit<TrackerFooterOptions, "socketPath"> = {
  intervalMs: SESSION_TRACKER_FOOTER_INTERVAL_MS,
  setInterval,
  clearInterval,
  send: requestTracker,
  log: writeSessionTrackerLog,
};

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

const inflightDaemonStarts = new Map<string, Promise<void>>();
const daemonStartFailures = new Map<string, { at: number; error: unknown }>();
const lastLoggedFailures = new Map<string, string>();

function failureLogCode(error: unknown): string {
  return (
    (error as NodeJS.ErrnoException).code ??
    (error instanceof Error ? error.message : String(error))
  );
}

function logTrackerFailure(
  options: Pick<TrackerRuntimeOptions, "socketPath" | "log">,
  context: string,
  error: unknown,
): void {
  const key = `${options.socketPath}\n${context}`;
  const code = failureLogCode(error);
  if (lastLoggedFailures.get(key) === code) return;
  lastLoggedFailures.set(key, code);
  options.log(options.socketPath, `client ${context} failed`, error);
}

function logTrackerRecovery(
  options: Pick<TrackerRuntimeOptions, "socketPath" | "log">,
  context: string,
): void {
  if (!lastLoggedFailures.delete(`${options.socketPath}\n${context}`)) return;
  options.log(options.socketPath, `client ${context} recovered`);
}

function startDaemonCoalesced(
  socketPath: string,
  options: Pick<TrackerRuntimeOptions, "spawnDaemon" | "awaitDaemonReady" | "log">,
): Promise<void> {
  const failure = daemonStartFailures.get(socketPath);
  if (failure && Date.now() - failure.at < DAEMON_START_FAILURE_COOLDOWN_MS)
    return Promise.reject(failure.error);

  let inflight = inflightDaemonStarts.get(socketPath);
  if (!inflight) {
    inflight = (async () => {
      options.spawnDaemon();
      await options.awaitDaemonReady(socketPath);
      daemonStartFailures.delete(socketPath);
    })()
      .catch((error) => {
        daemonStartFailures.set(socketPath, { at: Date.now(), error });
        options.log(socketPath, "client daemon start failed", error);
        throw error;
      })
      .finally(() => inflightDaemonStarts.delete(socketPath));
    inflightDaemonStarts.set(socketPath, inflight);
  }
  return inflight;
}

export async function requestSessionTracker(
  socketPath: string,
  request: TrackerRequest,
  options: Pick<TrackerRuntimeOptions, "send" | "spawnDaemon" | "awaitDaemonReady" | "log">,
): Promise<TrackerResponse> {
  try {
    return await options.send(socketPath, request);
  } catch (error) {
    if (!isSocketUnavailableError(error)) throw error;
    await startDaemonCoalesced(socketPath, options);
    return options.send(socketPath, request);
  }
}

interface PiSessionsPickerContext {
  ui: {
    notify(message: string, level: "info" | "warning" | "error"): void;
    select(title: string, choices: string[]): Promise<string | undefined>;
  };
}

export async function restartPiSessionsDaemon(
  options: Pick<TrackerRuntimeOptions, "socketPath" | "send" | "spawnDaemon">,
): Promise<void> {
  try {
    await options.send(options.socketPath, { type: "shutdown" });
  } catch (error) {
    if (!isSocketUnavailableError(error)) throw error;
  }
  options.spawnDaemon();
}

export async function runPiSessionsNext(
  ctx: Pick<PiSessionsPickerContext, "ui">,
  options: Pick<
    TrackerRuntimeOptions,
    "socketPath" | "send" | "spawnDaemon" | "awaitDaemonReady" | "paneId" | "log"
  >,
): Promise<void> {
  try {
    const response = await requestSessionTracker(
      options.socketPath,
      { type: "focus_next", currentPaneId: options.paneId },
      options,
    );
    if (!response.ok) ctx.ui.notify("No tracked Pi sessions to focus.", "info");
  } catch (error) {
    logTrackerFailure(options, "focus_next", error);
    ctx.ui.notify("Pi sessions are unavailable.", "warning");
  }
}

export async function runPiSessionsPicker(
  ctx: PiSessionsPickerContext,
  options: Pick<
    TrackerRuntimeOptions,
    "socketPath" | "send" | "spawnDaemon" | "awaitDaemonReady" | "log"
  >,
): Promise<void> {
  let records: PaneRecord[];
  try {
    const snapshot = await requestSessionTracker(options.socketPath, { type: "snapshot" }, options);
    records = sortPaneRecordsForPicker(snapshot.records ?? []);
  } catch (error) {
    logTrackerFailure(options, "picker snapshot", error);
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
      options.socketPath,
      { type: "focus_pane", paneId: record.paneId },
      options,
    );
  } catch (error) {
    logTrackerFailure(options, "focus_pane", error);
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

export function createSessionTrackerFooterRuntime(options: TrackerFooterOptions) {
  let timer: ReturnType<typeof setInterval> | undefined;

  return {
    start(
      ctx: TrackerContext & {
        ui: { setStatus(id: string, text: string | undefined): void; theme?: any };
      },
    ) {
      if (timer) options.clearInterval(timer);
      const setStatus = (text: string | undefined) => {
        try {
          ctx.ui.setStatus("session-tracker", text);
        } catch {
          /* stale ctx */
        }
      };
      const update = async () => {
        try {
          const response = await options.send(options.socketPath, { type: "snapshot" });
          logTrackerRecovery(options, "footer snapshot");
          setStatus(
            colorizeSessionTrackerFooter(
              formatSessionTrackerFooter(response.records ?? [], options.paneId),
              ctx.ui.theme,
            ),
          );
        } catch (error) {
          logTrackerFailure(options, "footer snapshot", error);
          setStatus(undefined);
        }
      };
      void update();
      timer = options.setInterval(() => void update(), options.intervalMs);
      timer.unref?.();
    },
    stop(ctx?: { ui?: { setStatus(id: string, text: string | undefined): void } }) {
      if (timer) options.clearInterval(timer);
      timer = undefined;
      try {
        ctx?.ui?.setStatus("session-tracker", undefined);
      } catch {
        /* stale ctx */
      }
    },
  };
}

export function createSessionTrackerRuntime(options: TrackerRuntimeOptions) {
  let seq = 0;
  let state: TrackerState = "idle";
  let ctx: TrackerContext | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;

  const disarm = () => {
    if (timer) options.clearInterval(timer);
    timer = undefined;
    ctx = undefined;
  };

  const record = (): PaneRecord | undefined => {
    if (!options.paneId || !ctx) return undefined;
    let cwd: string;
    let sessionId: string | undefined;
    try {
      // ctx.cwd and ctx.sessionManager are throwing getters once the ctx goes
      // stale after session replacement or reload.
      cwd = ctx.cwd;
      sessionId = ctx.sessionManager?.getSessionId?.();
    } catch {
      disarm();
      return undefined;
    }
    return {
      paneId: options.paneId,
      cwd,
      runtimeId: options.runtimeId,
      seq: ++seq,
      state,
      heartbeatAt: options.now(),
      ...(sessionId ? { sessionId } : {}),
    };
  };

  const call = (request: TrackerRequest) =>
    requestSessionTracker(options.socketPath, request, options);

  const sendBestEffort = async (request: TrackerRequest, autostart = true) => {
    try {
      if (autostart) await call(request);
      else await options.send(options.socketPath, request);
      logTrackerRecovery(options, request.type);
    } catch (error) {
      logTrackerFailure(options, request.type, error);
    }
  };

  const report = async (type: "report" | "heartbeat") => {
    const current = record();
    if (current) await sendBestEffort({ type, record: current });
  };

  return {
    async start(startCtx: TrackerContext) {
      if (timer) options.clearInterval(timer);
      timer = undefined;
      ctx = startCtx;
      await report("report");
      // stop() or a newer start() may have run while the first report was in
      // flight; creating the interval now would leak it with a stale ctx.
      if (ctx !== startCtx) return;
      timer = options.setInterval(() => void report("heartbeat"), options.heartbeatIntervalMs);
      timer.unref?.();
    },
    async setState(next: TrackerState) {
      state = next;
      await report("report");
    },
    async stop(release = false) {
      if (timer) options.clearInterval(timer);
      timer = undefined;
      if (release && options.paneId)
        await sendBestEffort(
          { type: "release", paneId: options.paneId, runtimeId: options.runtimeId },
          false,
        );
      ctx = undefined;
    },
  };
}

export default function registerSessionTracker(pi: ExtensionAPI): void {
  const runtimeId = randomUUID();
  const socketPath = getTrackerSocketPath();
  const paneId = process.env.TMUX_PANE;

  const runtime = createSessionTrackerRuntime({
    ...defaultTrackerRuntimeOptions,
    runtimeId,
    socketPath,
    paneId,
  });
  const footerRuntime = createSessionTrackerFooterRuntime({
    ...defaultTrackerFooterOptions,
    socketPath,
    paneId,
  });

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

  const defaultCallOptions = { ...defaultTrackerRuntimeOptions, socketPath };

  pi.registerCommand("pi-sessions", {
    description: "Pick a tracked Pi tmux pane to focus",
    handler: async (_args, ctx) => runPiSessionsPicker(ctx, defaultCallOptions),
  });
  pi.registerCommand("pi-sessions-restart-daemon", {
    description: "Restart the Pi sessions daemon",
    handler: async (_args, ctx) => {
      try {
        await restartPiSessionsDaemon(defaultCallOptions);
        ctx.ui.notify("Pi sessions daemon restarted.", "info");
      } catch (error) {
        logTrackerFailure(defaultCallOptions, "daemon restart", error);
        ctx.ui.notify("Failed to restart Pi sessions daemon.", "error");
      }
    },
  });
  pi.registerShortcut("alt+s", {
    description: "Focus next tracked Pi tmux pane",
    handler: async (ctx) => runPiSessionsNext(ctx, { ...defaultCallOptions, paneId }),
  });
}
