#!/usr/bin/env bun

import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { emitKeypressEvents } from "node:readline";

import {
  handleTauDashboardKey,
  loadTauDashboardSessions,
  reconcileTauDashboardSelection,
  renderTauDashboard,
  type LoadTauDashboardSessionsResult,
  type TauDashboardSelectionState,
} from "./index.js";

function clearScreen(): void {
  process.stdout.write("\x1b[?25l\x1b[2J\x1b[H");
}

function showCursor(): void {
  process.stdout.write("\x1b[?25h");
}

const TAU_DASHBOARD_REFRESH_INTERVAL_MS = 1_000;

function keyName(input: string, key?: { name?: string; ctrl?: boolean }): string {
  if (key?.ctrl && key.name === "c") return "q";
  return key?.name ?? input;
}

export async function main(): Promise<void> {
  let result: LoadTauDashboardSessionsResult = await loadTauDashboardSessions();
  let selection: TauDashboardSelectionState = reconcileTauDashboardSelection(result.sessions);
  let showHelp = false;
  let launchError: string | undefined;
  let quitting = false;
  const interactive = process.stdin.isTTY && process.stdout.isTTY;

  const render = (): void => {
    const width = process.stdout.columns || 100;
    const lines = renderTauDashboard(result.sessions, result.issues, {
      width,
      selectedSessionId: selection.selectedSessionId,
      showHelp,
    });
    if (interactive) clearScreen();
    if (launchError) lines.push("", launchError);
    process.stdout.write(`${lines.join("\n")}\n`);
  };

  if (!interactive) {
    render();
    return;
  }

  let refreshInFlight = false;
  let childPiRunning = false;
  const refresh = async (): Promise<void> => {
    if (refreshInFlight || quitting || childPiRunning) return;
    refreshInFlight = true;
    const previous = selection;
    try {
      const nextResult = await loadTauDashboardSessions();
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
    showCursor();
    process.stdout.write("\n");
  };

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
    showCursor();
    process.stdout.write("\n");

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
    const handled = handleTauDashboardKey(
      { sessions: result.sessions, selection, showHelp, quitting },
      keyName(input, key),
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
        if (selected) await runNativePi(selected.sessionFile);
        else render();
        break;
      }
      case "quit":
        quit();
        break;
    }
    if (handled.effect !== "quit") quitting = handled.state.quitting;
  });
  process.once("SIGINT", quit);
  process.once("exit", showCursor);
  render();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
