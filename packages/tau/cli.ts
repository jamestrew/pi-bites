#!/usr/bin/env bun

import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { emitKeypressEvents } from "node:readline";

import {
  defaultLoadTauDashboardSessionsOptions,
  handleTauDashboardKey,
  loadTauDashboardSessions,
  reconcileTauDashboardSelection,
  renderTauDashboard,
  type LoadTauDashboardSessionsResult,
  type TauDashboardSelectionState,
  type TauDashboardSession,
} from "./index.js";

function enterDashboardScreen(): void {
  process.stdout.write("\x1b[?1049h\x1b[?25l");
}

function renderDashboardScreen(lines: readonly string[]): void {
  process.stdout.write(`\x1b[H${lines.map((line) => `${line}\x1b[K`).join("\n")}\x1b[J`);
}

function leaveDashboardScreen(): void {
  process.stdout.write("\x1b[?25h\x1b[?1049l");
}

const TAU_DASHBOARD_REFRESH_INTERVAL_MS = 1_000;

function keyName(input: string, key?: { name?: string; ctrl?: boolean }): string {
  if (key?.ctrl && key.name === "c") return "q";
  return key?.name ?? input;
}

export async function main(): Promise<void> {
  let result: LoadTauDashboardSessionsResult = await loadTauDashboardSessions(
    defaultLoadTauDashboardSessionsOptions,
  );
  let selection: TauDashboardSelectionState = reconcileTauDashboardSelection(result.sessions);
  let showHelp = false;
  let launchError: string | undefined;
  let ownerWarningSessionId: string | undefined;
  let quitting = false;
  const interactive = process.stdin.isTTY && process.stdout.isTTY;

  const render = (): void => {
    const width = process.stdout.columns || 100;
    const lines = renderTauDashboard(result.sessions, result.issues, {
      width,
      selectedSessionId: selection.selectedSessionId,
      showHelp,
    });
    if (ownerWarningSessionId) {
      const warningSession = result.sessions.find(
        (session) => session.sessionId === ownerWarningSessionId,
      );
      if (warningSession) {
        lines.push(
          "",
          `Warning: ${warningSession.sessionId} appears to already have a live native pi owner (pid ${warningSession.pid}, heartbeat ${new Date(warningSession.heartbeatAt).toISOString()}).`,
          "Multiple native pi processes for one session are best-effort and undefined.",
          "Press o to open anyway, or c/Esc to cancel.",
        );
      } else {
        ownerWarningSessionId = undefined;
      }
    }
    if (launchError) lines.push("", launchError);
    if (interactive) renderDashboardScreen(lines);
    else process.stdout.write(`${lines.join("\n")}\n`);
  };

  if (!interactive) {
    render();
    return;
  }

  enterDashboardScreen();

  let refreshInFlight = false;
  let childPiRunning = false;
  const refresh = async (): Promise<void> => {
    if (refreshInFlight || quitting || childPiRunning) return;
    refreshInFlight = true;
    const previous = selection;
    try {
      const nextResult = await loadTauDashboardSessions(defaultLoadTauDashboardSessionsOptions);
      if (quitting || childPiRunning) return;
      result = nextResult;
      selection = reconcileTauDashboardSelection(result.sessions, {
        previousSessionId: previous.selectedSessionId,
        previousIndex: previous.selectedIndex,
      });
      render();
    } finally {
      refreshInFlight = false;
    }
  };

  let refreshTimer = setInterval(() => void refresh(), TAU_DASHBOARD_REFRESH_INTERVAL_MS);

  const quit = (): void => {
    if (quitting) return;
    quitting = true;
    clearInterval(refreshTimer);
    process.stdin.setRawMode(false);
    process.stdin.pause();
    leaveDashboardScreen();
  };

  const hasLikelyLiveOwner = (session: TauDashboardSession): boolean =>
    session.isLive && !session.isStale;

  const runNativePi = async (sessionFile: string): Promise<void> => {
    try {
      await access(sessionFile);
    } catch {
      launchError = `Cannot open missing Tau session file: ${sessionFile}`;
      render();
      return;
    }

    childPiRunning = true;
    clearInterval(refreshTimer);
    process.stdin.setRawMode(false);
    process.stdin.pause();
    leaveDashboardScreen();

    try {
      await new Promise<void>((resolve) => {
        const child = spawn("pi", ["--session", sessionFile], { stdio: "inherit" });
        child.once("error", (error) => {
          launchError = `Failed to launch native pi for ${sessionFile}: ${error.message}`;
          process.stderr.write(`${launchError}\n`);
          resolve();
        });
        child.once("exit", () => resolve());
      });
    } finally {
      if (!quitting) {
        childPiRunning = false;
        enterDashboardScreen();
        process.stdin.setRawMode(true);
        process.stdin.resume();
        await refresh();
        render();
        refreshTimer = setInterval(() => void refresh(), TAU_DASHBOARD_REFRESH_INTERVAL_MS);
      }
    }
  };

  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("keypress", async (input, key) => {
    const name = keyName(input, key);

    if (ownerWarningSessionId) {
      const warningSession = result.sessions.find(
        (session) => session.sessionId === ownerWarningSessionId,
      );
      if (name === "o" && warningSession) {
        ownerWarningSessionId = undefined;
        launchError = undefined;
        await runNativePi(warningSession.sessionFile);
      } else if (name === "c" || name === "escape") {
        ownerWarningSessionId = undefined;
        render();
      } else {
        render();
      }
      return;
    }

    const handled = handleTauDashboardKey(
      { sessions: result.sessions, selection, showHelp, quitting },
      name,
    );
    selection = handled.state.selection;
    showHelp = handled.state.showHelp;

    switch (handled.effect) {
      case "render":
        render();
        break;
      case "refresh":
        await refresh();
        break;
      case "open": {
        launchError = undefined;
        const selected = result.sessions.find(
          (session) => session.sessionId === selection.selectedSessionId,
        );
        if (selected) {
          if (hasLikelyLiveOwner(selected)) {
            ownerWarningSessionId = selected.sessionId;
            render();
          } else {
            await runNativePi(selected.sessionFile);
          }
        } else render();
        break;
      }
      case "quit":
        quit();
        break;
    }
    if (handled.effect !== "quit") quitting = handled.state.quitting;
  });
  process.once("SIGINT", quit);
  process.once("exit", leaveDashboardScreen);
  render();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
