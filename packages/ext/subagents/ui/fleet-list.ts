/**
 * fleet-list.ts — Claude Code-style "FleetView" list rendered above the editor.
 *
 * Shows `main` + each running/queued background subagent as a navigable list. Pressing
 * Ctrl+↑ activates the list; ↑/↓ move the selection, Enter opens the selected agent's
 * live conversation overlay, Esc returns to the prompt. A viewer stays open when its
 * agent finishes; finished agents linger briefly in the list.
 *
 * Mechanics (see plan): the list is an `aboveEditor` widget (render-only), and ALL key
 * handling goes through `onTerminalInput` — which fires before the focused editor and
 * can `consume` keys. Activation uses Ctrl+↑ so normal typing is untouched.
 */

import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import {
  isKeyRelease,
  Key,
  matchesKey,
  type TUI,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { AgentManager } from "../agent-manager.js";
import type { AgentRecord } from "../types.js";
import { getLifetimeTotal } from "../usage.js";
import {
  type AgentActivity,
  formatBashApprovalActivity,
  getDisplayName,
  type Theme,
} from "./agent-format.js";
import { ConversationViewer } from "./conversation-viewer.js";

/** Widget key for the FleetView list. */
const FLEET_KEY = "fleet";
/** Max agent rows shown at once; extras collapse into a "↓ N more" indicator. */
const MAX_AGENT_ROWS = 5;
/** Re-render cadence so elapsed/token stats tick while agents run. */
const TICK_MS = 200;
/** How long a finished agent lingers in the list before it drops out. */
const FINISHED_LINGER_MS = 500;

/** Minimal UI surface the FleetView needs from `ctx.ui`. */
export type FleetUICtx = Pick<
  ExtensionUIContext,
  "setWidget" | "onTerminalInput" | "getEditorText" | "notify" | "custom"
>;

type MainEntry = { kind: "main" };
type AgentEntry = { kind: "agent"; record: AgentRecord };
type FleetEntry = MainEntry | AgentEntry;

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
  private inputUnsub: (() => void) | undefined;
  private widgetRegistered = false;
  private timer: ReturnType<typeof setInterval> | undefined;

  private enabled = true;
  /** Whether arrow keys currently navigate the list (vs. flow to the editor). */
  private active = false;
  /** 0 = `main`, 1..N = subagents. */
  private selectedIndex = 0;
  /** Set while a conversation overlay is open; calling it closes the overlay. */
  private viewerClose: (() => void) | undefined;
  private viewingAgentId: string | undefined;

  constructor(
    private manager: AgentManager,
    private agentActivity: Map<string, AgentActivity>,
  ) {}

  // ---- Lifecycle ----

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    if (!enabled) this.active = false;
    this.update();
  }

  /** Capture the UI context and (re)register the global input handler. */
  setUICtx(ui: FleetUICtx): void {
    if (ui === this.ui) return;
    this.inputUnsub?.();
    this.ui = ui;
    this.widgetRegistered = false;
    this.tui = undefined;
    this.inputUnsub = ui.onTerminalInput((data) => this.handleKey(data));
  }

  /** Ensure the re-render timer is running (called when an agent spawns). */
  ensureTimer(): void {
    if (!this.timer) this.timer = setInterval(() => this.update(), TICK_MS);
  }

  setWaitingForBashApproval(agentId: string, requestId: string, command?: string): void {
    const activity = this.agentActivity.get(agentId);
    if (activity) {
      if (command)
        activity.bashApproval = {
          requestId,
          command: command.replace(/\s+/g, " ").trim(),
        };
      else if (activity.bashApproval?.requestId === requestId) delete activity.bashApproval;
    }
    this.update();
  }

  /**
   * Called when an agent finishes. The viewer (if open on it) stays open so the
   * final output remains readable, and the row lingers in the list — just refresh.
   */
  onAgentFinished(_id: string): void {
    this.update();
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.inputUnsub?.();
    this.inputUnsub = undefined;
    if (this.viewerClose) {
      this.viewerClose();
      this.viewerClose = undefined;
    }
    this.viewingAgentId = undefined;
    if (this.ui && this.widgetRegistered) this.ui.setWidget(FLEET_KEY, undefined);
    this.widgetRegistered = false;
    this.tui = undefined;
    this.active = false;
    // Null last so a `viewerClose()` microtask above can't re-register the widget.
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
      this.active = false;
      this.selectedIndex = 0;
      return;
    }

    this.clampSelection();
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

  /**
   * Agents shown in the list, ordered earliest-launched first so the ones you
   * started sooner sit at the top. Every row is openable (has a session), so Enter
   * never dead-ends. Included: running/queued, plus the agent currently being
   * viewed, plus recently-finished ones (they linger briefly before dropping out).
   * Foreground agents are hidden because their inline tool result is already visible.
   * (`listAgents()` is newest-first, so we re-sort.)
   */
  private agentRecords(): AgentRecord[] {
    const now = Date.now();
    return this.manager
      .listAgents()
      .filter(
        (a) =>
          a.isBackground !== false &&
          (a.status === "running" ||
            a.status === "queued" ||
            a.id === this.viewingAgentId ||
            (a.session && a.completedAt != null && now - a.completedAt < FINISHED_LINGER_MS)),
      )
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  private roster(): FleetEntry[] {
    return [
      { kind: "main" },
      ...this.agentRecords().map((record) => ({ kind: "agent" as const, record })),
    ];
  }

  private clampSelection(): void {
    const max = this.roster().length - 1;
    if (this.selectedIndex > max) this.selectedIndex = Math.max(0, max);
    if (this.selectedIndex < 0) this.selectedIndex = 0;
  }

  // ---- Key handling ----

  /** Returns `{consume:true}` to swallow a key, or undefined to let it through. */
  handleKey(data: string): { consume?: boolean; data?: string } | undefined {
    if (!this.enabled || !this.ui) return undefined;
    // Input listeners receive BOTH key-press and key-release (the kitty protocol
    // emits both, and matchesKey matches either) — act on press only, or every
    // tap would move/fire twice. Repeats still pass through for held-key nav.
    if (isKeyRelease(data)) return undefined;
    // While an overlay is open, let it own all input.
    if (this.viewerClose) return undefined;

    if (!this.active) {
      // Activate: Ctrl+↑ moves focus into the list.
      const isActivator = matchesKey(data, "ctrl+up");
      if (isActivator && this.agentRecords().length > 0) {
        this.active = true;
        this.selectedIndex = this.roster().length - 1;
        this.update();
        return { consume: true };
      }
      return undefined;
    }

    // Active — arrows navigate, Enter opens, Esc / Up-past-top exits.
    if (matchesKey(data, "down") || matchesKey(data, "ctrl+down")) {
      const max = this.roster().length - 1;
      if (this.selectedIndex === max) {
        this.deactivate();
        return { consume: true };
      }
      this.selectedIndex = Math.min(max, this.selectedIndex + 1);
      this.update();
      return { consume: true };
    }
    if (matchesKey(data, "up") || matchesKey(data, "ctrl+up")) {
      if (this.selectedIndex === 0) {
        this.deactivate();
        return { consume: true };
      }
      this.selectedIndex -= 1;
      this.update();
      return { consume: true };
    }
    if (matchesKey(data, "escape")) {
      this.deactivate();
      return { consume: true };
    }
    if (matchesKey(data, Key.enter)) {
      this.openSelected();
      return { consume: true };
    }

    // Any other key cancels navigation and flows to the editor.
    this.deactivate();
    return undefined;
  }

  private deactivate(): void {
    this.active = false;
    this.selectedIndex = 0;
    this.update();
  }

  private openSelected(): void {
    const entry = this.roster()[this.selectedIndex];
    if (entry.kind === "main") {
      // `main` = return to the prompt; the native transcript is already shown.
      this.deactivate();
      return;
    }
    const record = entry.record;
    if (!this.ui) return;
    if (!record.session) {
      this.ui.notify(`Agent is ${record.status} — no session available.`, "info");
      return;
    }
    const session = record.session;
    const activity = this.agentActivity.get(record.id);
    this.viewingAgentId = record.id;

    void this.ui
      .custom<undefined>((tui, theme, keybindings, done) => {
        this.viewerClose = () => done(undefined);
        return new ConversationViewer(
          tui,
          session,
          record,
          activity,
          theme,
          done,
          () => {
            if (this.manager.abort(record.id))
              this.ui?.notify(`Stopped "${record.description}".`, "info");
          },
          keybindings,
          (message: string) => this.manager.steer(record.id, message),
          (message: string) => {
            if (this.manager.cancelAndSteer(record.id, message))
              this.ui?.notify(`Canceled current operation for "${record.description}".`, "info");
          },
        );
      })
      .then(
        () => this.clearViewer(),
        () => this.clearViewer(),
      );
  }

  /** Reset overlay state and return to the list (on close, auto-close, or error). */
  private clearViewer(): void {
    // Keep the cursor on the agent we were viewing — re-resolve by id so it
    // still feels natural if the list reordered (an earlier agent finished)
    // while the overlay was open. If that agent is gone, leave the index for
    // update()'s clamp to settle.
    if (this.viewingAgentId) {
      const idx = this.roster().findIndex(
        (e) => e.kind === "agent" && e.record.id === this.viewingAgentId,
      );
      if (idx >= 0) this.selectedIndex = idx;
    }
    this.viewerClose = undefined;
    this.viewingAgentId = undefined;
    this.update();
  }

  // ---- Rendering ----

  private renderBar(width: number, theme: Theme): string[] {
    const agents = this.roster().filter((entry): entry is AgentEntry => entry.kind === "agent");
    if (agents.length === 0) return [];
    // Clamp locally so a render between a roster shrink and the next update()
    // (e.g. on terminal resize) never loses the selection marker.
    const sel = Math.min(this.selectedIndex, agents.length);

    const hint = this.active
      ? "FleetView focused · ↑↓ select · enter view · esc back"
      : "ctrl+↑ focus agents";
    const lines: string[] = [];
    lines.push(truncateToWidth("  " + theme.fg("dim", hint), width));
    lines.push(truncateToWidth(`${this.cursor(0, sel)}${theme.fg("success", "•")} main`, width));

    // Window the agent rows so the selected one stays visible.
    const visible = Math.min(MAX_AGENT_ROWS, agents.length);
    const selAgent = Math.max(0, sel - 1);
    const start = selAgent < visible ? 0 : selAgent - visible + 1;
    const hiddenBelow = agents.length - (start + visible);

    if (start > 0) lines.push(rightAlign("", theme.fg("dim", `↑ ${start} more`), width));
    for (let a = start; a < start + visible; a++) {
      lines.push(this.renderAgentRow(a + 1, sel, agents[a].record, width, theme));
    }
    if (hiddenBelow > 0)
      lines.push(rightAlign("", theme.fg("dim", `↓ ${hiddenBelow} more`), width));

    return lines;
  }

  private cursor(rosterIndex: number, sel: number): string {
    return `  ${this.active && rosterIndex === sel ? "▶" : " "} `;
  }

  private renderAgentRow(
    rosterIndex: number,
    sel: number,
    record: AgentRecord,
    width: number,
    theme: Theme,
  ): string {
    const approvalCommand = this.agentActivity.get(record.id)?.bashApproval?.command;
    const summary = approvalCommand
      ? formatBashApprovalActivity(approvalCommand)
      : record.description;
    const left = `${this.cursor(rosterIndex, sel)}  ${theme.fg("muted", getDisplayName(record.type))}  ${summary}`;
    const tokens = getLifetimeTotal(
      this.agentActivity.get(record.id)?.lifetimeUsage ?? record.lifetimeUsage,
    );
    const elapsedMs = (record.completedAt ?? Date.now()) - record.startedAt; // freezes once finished
    const right = theme.fg(
      "dim",
      `${formatFleetElapsed(elapsedMs)} · ${formatFleetTokens(tokens)}`,
    );
    return rightAlign(left, right, width);
  }
}
