#!/usr/bin/env bun

import { loadTauDashboardSessions } from "./index.js";
import { renderTauDashboard } from "./dashboard.js";

export async function main(): Promise<void> {
  const result = await loadTauDashboardSessions();
  const width = process.stdout.columns || 100;
  process.stdout.write(
    `${renderTauDashboard(result.sessions, result.issues, { width }).join("\n")}\n`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
