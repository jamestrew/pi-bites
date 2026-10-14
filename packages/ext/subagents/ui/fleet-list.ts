/** Compact, read-only subagent status rendered above the editor. */

import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { sanitizeSingleLine } from "../../shared/terminal-text.js";
import { lifecycleStatusLabel } from "./agent-lifecycle-render.js";
import { getAgentStatus } from "../agent-status.js";
import type { AgentManager } from "../agent-manager.js";
import type { AgentRecord } from "../types.js";
import { getLifetimeTotal } from "../usage.js";
import { getDisplayName, type Theme } from "./agent-format.js";

/** Widget key for the Fleet list. */
const FLEET_KEY = "fleet";
/** Max agent rows shown at once; extras collapse into a "↓ N more" indicator. */
const MAX_AGENT_ROWS = 5;
/** Re-render cadence so elapsed/token stats tick while agents run. */
const TICK_MS = 200;
/** How long a finished agent lingers in the list before it drops out. */
const FINISHED_LINGER_MS = 500;

/** Minimal UI surface the Fleet needs from `ctx.ui`. */
export type FleetUICtx = Pick<ExtensionUIContext, "setWidget">;

/** `11s` — integer seconds, no decimal/suffix (matches Claude Code, unlike formatMs). */
export function formatFleetElapsed(ms: number): string {
  return `${Math.max(0, Math.round(ms / 1000))}s`;
}

/** `↓ 13.1k tokens` — down-arrow prefix, compact magnitude, plural "tokens". */
export function formatFleetTokens(count: number): string {
  let compact: string;
  if (count >= 1_000_000) compact = `${(count / 1_000_000).toFixed(1)}M`;
  else if (count >= 1_000) compact = `${(count / 1_000).toFixed(1)}k`;
  else compact = `${count}`;
  return `↓ ${compact} tokens`;
}

/**
 * Place `right` flush to `width`, truncating `left` first so the stats survive.
 * The final clamp guarantees the line never exceeds `width` (which would wrap and
 * desync pi's line-diff → flicker) even on a terminal too narrow for the stats.
 */
function rightAlign(left: string, right: string, width: number): string {
  const rightW = visibleWidth(right);
  const maxLeft = Math.max(0, width - rightW - 1);
  const leftClamped = truncateToWidth(left, maxLeft);
  const gap = Math.max(1, width - visibleWidth(leftClamped) - rightW);
  return truncateToWidth(leftClamped + " ".repeat(gap) + right, width);
}

export class FleetList {
  private ui: FleetUICtx | undefined;
  private tui: TUI | undefined;
  private widgetRegistered = false;
  private timer: ReturnType<typeof setInterval> | undefined;

  private enabled = true;
  /** Unread mail counts for visible agents; mail does not keep a finished row alive. */
  private pendingMail = new Map<string, number>();

  constructor(private manager: AgentManager) {}

  // ---- Lifecycle ----

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    this.update();
  }

  /** Capture a stable UI dependency while the owning context is active. */
  setUICtx(ui: FleetUICtx): void {
    if (ui === this.ui) return;
    this.ui = ui;
    this.widgetRegistered = false;
    this.tui = undefined;
  }

  /** Ensure the re-render timer is running (called when an agent spawns). */
  ensureTimer(): void {
    if (!this.timer) this.timer = setInterval(() => this.update(), TICK_MS);
  }

  setPendingMail(id: string, count: number): void {
    if (count > 0) {
      this.pendingMail.set(id, count);
      this.ensureTimer();
    } else this.pendingMail.delete(id);
    this.update();
  }

  /** Let finished agents linger briefly before their rows drop out. */
  onAgentFinished(): void {
    this.update();
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.ui && this.widgetRegistered) this.ui.setWidget(FLEET_KEY, undefined);
    this.widgetRegistered = false;
    this.tui = undefined;
    this.pendingMail.clear();
    this.ui = undefined;
  }

  /** Re-register/refresh the above-editor widget; clears it when no agents remain. */
  update(): void {
    if (!this.ui) return;
    const hasAgents = this.enabled && this.agentRecords().length > 0;

    if (!hasAgents) {
      if (this.widgetRegistered) {
        this.ui.setWidget(FLEET_KEY, undefined);
        this.widgetRegistered = false;
        this.tui = undefined;
      }
      if (this.timer) {
        clearInterval(this.timer);
        this.timer = undefined;
      }
      return;
    }

    this.ensureTimer(); // keep stats ticking whenever the list is shown (e.g. after a re-enable)

    if (!this.widgetRegistered) {
      this.ui.setWidget(
        FLEET_KEY,
        (tui, theme) => {
          this.tui = tui;
          return {
            render: (w: number) => this.renderBar(w, theme),
            invalidate: () => {
              this.widgetRegistered = false;
              this.tui = undefined;
            },
          };
        },
        { placement: "aboveEditor" },
      );
      this.widgetRegistered = true;
    } else {
      this.tui?.requestRender();
    }
  }

  // ---- Roster ----

  /** Live/idle agents plus recently finished ones, earliest-launched first. */
  private agentRecords(): AgentRecord[] {
    const now = Date.now();
    const records = this.manager.listAgents();
    return records
      .filter(
        (a) =>
          a.status === "idle" ||
          a.status === "running" ||
          a.status === "queued" ||
          Boolean(
            (a.session || a.retainedConversation) &&
            a.completedAt != null &&
            now - a.completedAt < FINISHED_LINGER_MS,
          ),
      )
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  // ---- Rendering ----

  private renderBar(width: number, theme: Theme): string[] {
    const agents = this.agentRecords();
    if (agents.length === 0) return [];
    const lines = [truncateToWidth(`  ${theme.fg("success", "•")} main`, width)];
    for (const record of agents.slice(0, MAX_AGENT_ROWS)) {
      lines.push(this.renderAgentRow(record, width, theme));
    }
    const hidden = agents.length - MAX_AGENT_ROWS;
    if (hidden > 0) lines.push(rightAlign("", theme.fg("dim", `↓ ${hidden} more`), width));
    return lines;
  }

  private renderAgentRow(record: AgentRecord, width: number, theme: Theme): string {
    const pending = this.pendingMail.get(record.id);
    const lifecycle = lifecycleStatusLabel(getAgentStatus(record, false), record.status);
    const residency = !record.session && record.retainedConversation ? " · unloaded" : "";
    const interaction = pending ? ` · ${pending} pending message${pending === 1 ? "" : "s"}` : "";
    const left = `    ${theme.fg("muted", sanitizeSingleLine(getDisplayName(record.type)))}  ${sanitizeSingleLine(record.description)}${theme.fg("dim", ` · ${lifecycle}${residency}${interaction}`)}`;
    const tokens = getLifetimeTotal(record.lifetimeUsage);
    const elapsedMs = (record.completedAt ?? Date.now()) - record.startedAt; // freezes once finished
    const right = theme.fg(
      "dim",
      `${formatFleetElapsed(elapsedMs)} · ${formatFleetTokens(tokens)}`,
    );
    return rightAlign(left, right, width);
  }
}
