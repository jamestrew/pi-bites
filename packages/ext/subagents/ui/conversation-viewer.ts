/**
 * conversation-viewer.ts — Live split-pane view of agent sessions.
 *
 * Displays a scrollable, live-updating view of an agent's conversation.
 * Subscribes to session events for real-time streaming updates.
 */

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Input,
  matchesKey,
  type TUI,
  truncateToWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { extractText } from "../message-text.js";
import { formatToolCall } from "./tool-call-format.js";
import { sanitizeText } from "./text-lines.js";
import type { AgentRecord } from "../types.js";
import { getLifetimeTotal, getSessionContextPercent } from "../usage.js";
import type { Theme } from "./agent-format.js";
import {
  type AgentActivity,
  buildInvocationTags,
  describeActivity,
  formatDuration,
  formatSessionTokens,
  getDisplayName,
} from "./agent-format.js";
import { createViewerKeys, type ViewerKeybindings, type ViewerKeys } from "./viewer-keys.js";

/** Base lines consumed by chrome: header + two blank separators + footer. */
const CHROME_LINES_BASE = 4;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export const CONVERSATION_OVERLAY_OPTIONS = {
  overlay: true,
  overlayOptions: { width: "100%", maxHeight: "100%", margin: 0 },
} as const;

const MIN_VIEWPORT = 3;

export class ConversationViewer implements Component {
  private scrollOffset = 0;
  private autoScroll = true;
  private unsubscribe: (() => void) | undefined;
  private lastInnerW = 0;
  private closed = false;
  /** Two-press confirm guard for the stop key, so a stray key can't kill the agent. */
  private stopArmed = false;
  private keys: ViewerKeys;
  /** Steering composer — present while the user is typing a message to the agent. */
  private composer: Input | undefined;
  private composerMode: "steer" | "cancel" = "steer";

  constructor(
    private tui: TUI,
    private session: AgentSession,
    private record: AgentRecord,
    private activity: AgentActivity | undefined,
    private theme: Theme,
    private done: (result: undefined) => void,
    /** Abort the agent shown here. Omitted → no stop affordance (e.g. read-only history). */
    private onStop?: () => void,
    /** User keybindings from `ctx.ui.custom()`. Omitted → hardcoded defaults. */
    keybindings?: ViewerKeybindings,
    /** Send a steering message to the agent. Omitted → no compose affordance. */
    private onSteer?: (message: string) => void,
    /** Cancel the current operation, then resume with this steering message. */
    private onCancelSteer?: (message: string) => void,
  ) {
    this.keys = createViewerKeys(keybindings);
    this.unsubscribe = session.subscribe(() => {
      if (this.closed) return;
      this.tui.requestRender();
    });
  }

  handleInput(data: string): void {
    // While composing a steer message, the input owns all keys (Enter sends,
    // Esc cancels — both wired in openComposer()). Editing keys flow through.
    if (this.composer) {
      this.composer.handleInput(data);
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "escape") || matchesKey(data, "q")) {
      this.closed = true;
      this.done(undefined);
      return;
    }

    // Enter opens the steering composer (only while the agent can still be
    // steered) — then type + Enter sends, Esc or an empty submit returns. When
    // not steerable, fall through so the key still disarms a pending stop.
    if (matchesKey(data, "enter") && this.canSteer()) {
      this.stopArmed = false;
      this.openComposer("steer");
      return;
    }

    // Cancel the current operation (e.g. a long bash command), then resume with
    // the typed steering message. Keeping it one action prevents the parent
    // agent from resuming between cancel and steer.
    if (matchesKey(data, "c") && this.canCancel()) {
      this.stopArmed = false;
      this.openComposer("cancel");
      return;
    }

    // Stop/abort the agent (only while it can still be stopped). Two-press:
    // first "x" arms, second confirms — any other key disarms.
    if (matchesKey(data, "x")) {
      if (this.isStoppable()) {
        if (this.stopArmed) {
          this.stopArmed = false;
          this.onStop?.();
        } else {
          this.stopArmed = true;
        }
        this.tui.requestRender();
      }
      return;
    }
    if (this.stopArmed) this.stopArmed = false;

    const totalLines = this.buildContentLines(this.lastInnerW).length;
    const viewportHeight = this.viewportHeight();
    const maxScroll = Math.max(0, totalLines - viewportHeight);

    if (this.keys.scrollUp(data)) {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      this.autoScroll = this.scrollOffset >= maxScroll;
    } else if (this.keys.scrollDown(data)) {
      this.scrollOffset = Math.min(maxScroll, this.scrollOffset + 1);
      this.autoScroll = this.scrollOffset >= maxScroll;
    } else if (this.keys.pageUp(data)) {
      this.scrollOffset = Math.max(0, this.scrollOffset - viewportHeight);
      this.autoScroll = false;
    } else if (this.keys.pageDown(data)) {
      this.scrollOffset = Math.min(maxScroll, this.scrollOffset + viewportHeight);
      this.autoScroll = this.scrollOffset >= maxScroll;
    } else if (matchesKey(data, "home")) {
      this.scrollOffset = 0;
      this.autoScroll = false;
    } else if (matchesKey(data, "end")) {
      this.scrollOffset = maxScroll;
      this.autoScroll = true;
    }
  }

  render(width: number): string[] {
    if (width < 4) return [];
    const th = this.theme;
    this.lastInnerW = width;
    const lines: string[] = [];

    const name = getDisplayName(this.record.type);
    const statusIcon =
      this.record.status === "running"
        ? th.fg("accent", "●")
        : this.record.status === "completed"
          ? th.fg("success", "✓")
          : this.record.status === "error"
            ? th.fg("error", "✗")
            : th.fg("dim", "○");
    const duration = formatDuration(this.record.startedAt, this.record.completedAt);
    const headerParts: string[] = [duration];
    const toolUses = this.activity?.toolUses ?? this.record.toolUses;
    if (toolUses > 0) headerParts.unshift(`${toolUses} tool${toolUses === 1 ? "" : "s"}`);
    const tokens = getLifetimeTotal(this.activity?.lifetimeUsage);
    if (tokens > 0) {
      const percent = getSessionContextPercent(this.activity?.session);
      headerParts.push(formatSessionTokens(tokens, percent, th, this.record.compactionCount));
    }

    lines.push(
      truncateToWidth(
        `${statusIcon} ${th.bold(name)}  ${th.fg("muted", this.record.description)} ${th.fg("dim", "·")} ${th.fg("dim", headerParts.join(" · "))}`,
        width,
      ),
    );
    const invocationLine = this.invocationLine();
    if (invocationLine) lines.push(truncateToWidth(invocationLine, width));
    lines.push("");

    const contentLines = this.buildContentLines(width);
    const viewportHeight = this.viewportHeight();
    const maxScroll = Math.max(0, contentLines.length - viewportHeight);
    if (this.autoScroll) this.scrollOffset = maxScroll;

    const visibleStart = Math.min(this.scrollOffset, maxScroll);
    const visible = contentLines.slice(visibleStart, visibleStart + viewportHeight);
    for (let i = 0; i < viewportHeight; i++) lines.push(visible[i] ?? "");

    lines.push("");
    if (this.composer) {
      lines.push(truncateToWidth(this.composer.render(width)[0] ?? "", width));
      const composeLeft = this.theme.fg(
        "accent",
        this.composerMode === "cancel" ? "✎ cancel + steer" : "✎ steer",
      );
      lines.push(
        truncateToWidth(`${composeLeft} ${th.fg("dim", "Enter send · Esc cancel")}`, width),
      );
    } else {
      const hints: string[] = [];
      if (this.canSteer()) hints.push("Enter steer");
      if (this.canCancel()) hints.push("c cancel");
      if (this.isStoppable()) hints.push(this.stopArmed ? "x again to STOP" : "x stop");
      hints.push("Home top", "↑↓ scroll", "PgUp/PgDn or Shift+↑↓", "Esc close");
      lines.push(
        truncateToWidth(
          hints
            .map((hint) => (hint === "x again to STOP" ? th.fg("error", hint) : th.fg("dim", hint)))
            .join(th.fg("dim", " · ")),
          width,
        ),
      );
    }

    return lines;
  }

  /** Stoppable only when a stop handler exists and the agent is still active. */
  private isStoppable(): boolean {
    return !!this.onStop && (this.record.status === "running" || this.record.status === "queued");
  }

  /** Messageable only while the agent is still active. */
  private canSteer(): boolean {
    return !!this.onSteer && (this.record.status === "running" || this.record.status === "queued");
  }

  /** Cancelable only while a live session is active. */
  private canCancel(): boolean {
    return !!this.onCancelSteer && this.record.status === "running";
  }

  /** Open the inline steering composer and route subsequent input to it. */
  private openComposer(mode: "steer" | "cancel"): void {
    this.composerMode = mode;
    const input = new Input();
    input.focused = true;
    input.onSubmit = (value: string) => {
      const message = value.trim();
      const mode = this.composerMode;
      this.composer = undefined;
      if (message) {
        if (mode === "cancel") this.onCancelSteer?.(message);
        else this.onSteer?.(message);
      }
      this.tui.requestRender();
    };
    input.onEscape = () => {
      this.composer = undefined;
      this.tui.requestRender();
    };
    this.composer = input;
    this.tui.requestRender();
  }

  invalidate(): void {
    /* no cached state to clear */
  }

  dispose(): void {
    this.closed = true;
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
  }

  // ---- Private ----

  private viewportHeight(): number {
    return Math.max(MIN_VIEWPORT, this.tui.terminal.rows - this.chromeLines());
  }

  private chromeLines(): number {
    // The composer adds one row above the footer hint while it's open.
    return CHROME_LINES_BASE + (this.invocationLine() ? 1 : 0) + (this.composer ? 1 : 0);
  }

  private invocationLine(): string | undefined {
    const { modelName, tags } = buildInvocationTags(this.record.invocation);
    const parts = modelName ? [modelName, ...tags] : tags;
    if (parts.length === 0) return undefined;
    return this.theme.fg("dim", `  ↳ ${parts.join(" · ")}`);
  }

  private formatToolCall(call: unknown): string {
    if (!isRecord(call)) return `→ ${formatToolCall("unknown", {})}`;

    const name = typeof call.name === "string" ? call.name : "unknown";
    const rawArgs = call.arguments ?? call.input;
    return `→ ${formatToolCall(name, isRecord(rawArgs) ? rawArgs : {})}`;
  }

  private buildContentLines(width: number): string[] {
    if (width <= 0) return [];

    const th = this.theme;
    const messages = this.session.messages;
    const lines: string[] = [];
    const appendBlock = (block: string[]) => {
      if (block.length === 0) return;
      if (lines.length > 0) lines.push("");
      lines.push(...block);
    };
    const wrap = (text: string, wrapWidth = width) =>
      wrapTextWithAnsi(sanitizeText(text).trim(), Math.max(1, wrapWidth));

    const errors = new Map<string, string>();
    for (const msg of messages) {
      if (msg.role !== "toolResult" || !msg.isError) continue;
      const firstLine = sanitizeText(extractText(msg.content)).split("\n").at(0) ?? "";
      errors.set(msg.toolCallId, firstLine.trim() || "(no output)");
    }

    const prompt = sanitizeText(this.record.prompt).trim();
    if (prompt) {
      appendBlock([
        ...wrap(prompt).map((line) => th.fg("userMessageText", line)),
        th.fg("userMessageText", "---"),
      ]);
    }

    let firstUserSeen = false;
    for (const msg of messages) {
      if (msg.role === "user") {
        const text = typeof msg.content === "string" ? msg.content : extractText(msg.content);
        const clean = sanitizeText(text).trim();
        if (!clean) continue;
        if (!firstUserSeen) {
          firstUserSeen = true;
          if (prompt && clean.endsWith(prompt)) continue;
        }
        const wrapped = wrap(clean, width - 2);
        appendBlock(
          wrapped.map((line, index) =>
            th.fg("userMessageText", `${index === 0 ? "> " : "  "}${line}`),
          ),
        );
      } else if (msg.role === "assistant") {
        let tools: string[] = [];
        const flushTools = () => {
          appendBlock(tools);
          tools = [];
        };
        for (const content of msg.content) {
          if (content.type === "text" && content.text.trim()) {
            flushTools();
            appendBlock(wrap(content.text));
          } else if (content.type === "toolCall") {
            const callLines = wrap(this.formatToolCall(content)).map((line) =>
              th.fg("muted", line),
            );
            tools.push(...callLines);
            const error = errors.get(content.id);
            if (error) tools.push(th.fg("error", `    error: ${error}`));
          }
        }
        flushTools();
      } else if (msg.role === "bashExecution") {
        appendBlock(wrap(`$ ${msg.command}`).map((line) => th.fg("muted", line)));
      }
    }

    if (lines.length === 0) lines.push(th.fg("dim", "(waiting for first message...)"));

    if (this.record.status === "running" && this.activity) {
      const act = describeActivity(this.activity.activeTools, this.activity.responseText);
      appendBlock([th.fg("accent", "▍ ") + th.fg("dim", sanitizeText(act))]);
    }

    return lines.map((line) => truncateToWidth(line, width));
  }
}
