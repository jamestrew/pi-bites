import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { AgentManager } from "../agent-manager.js";
import type { AgentRecord } from "../types.js";
import { getDisplayName } from "../ui/agent-format.js";
import {
  FleetList,
  type FleetUICtx,
  formatFleetElapsed,
  formatFleetTokens,
} from "../ui/fleet-list.js";

// ---- Key sequences (see node_modules/@earendil-works/pi-tui/dist/keys.js) ----
const DOWN = "\x1b[B";
const UP = "\x1b[A";
const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const CTRL_UP = "\x1b[1;5A";
const CTRL_DOWN = "\x1b[1;5B";
const ESC = "\x1b";
const ENTER = "\r";
// Kitty-protocol key-RELEASE for ↓ (event type 3) — listeners receive these too.
const DOWN_RELEASE = "\x1b[1;1:3B";

const theme = { fg: (c: string, s: string) => `<${c}>${s}</${c}>`, bold: (s: string) => `*${s}*` };

/** A no-op session so a record is "openable" by default (the list hides session-less agents). */
const FAKE_SESSION = { subscribe: () => () => {}, messages: [] };

function makeRecord(over: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "a1",
    type: "general-purpose",
    description: "Sleep then report 1",
    status: "running",
    toolUses: 0,
    startedAt: Date.now(),
    session: FAKE_SESSION as any,
    lifetimeUsage: { input: 13100, output: 0, cacheWrite: 0 },
    compactionCount: 0,
    isBackground: true,
    ...over,
  } as AgentRecord;
}

/** Fake manager exposing only what FleetList touches. */
function fakeManager(agents: AgentRecord[]): AgentManager {
  return {
    listAgents: () => agents,
    abort: () => true,
    steer: vi.fn(() => true),
  } as unknown as AgentManager;
}

interface Harness {
  fleet: FleetList;
  ui: FleetUICtx;
  manager: AgentManager;
  /** The overlay component (a real ConversationViewer) once one is opened. */
  overlayComponent: () => { handleInput(data: string): void } | undefined;
  /** Feed a key to the registered input handler; returns the consume result. */
  press: (data: string) => { consume?: boolean } | undefined;
  /** Render the currently-registered FleetView widget at the given width. */
  render: (width?: number) => string[];
  setEditorText: (t: string) => void;
  /** Whether an overlay has been opened. */
  overlayOpened: () => boolean;
  /** Whether the most recently opened overlay's `done` was invoked (closed). */
  overlayClosed: () => boolean;
  /** Simulate the viewer closing itself (Esc → done); flushes the close microtask. */
  closeOverlay: () => Promise<void>;
}

function harness(agents: AgentRecord[]): Harness {
  let inputHandler: ((data: string) => { consume?: boolean } | undefined) | undefined;
  let widgetFactory: ((tui: any, theme: any) => { render(w: number): string[] }) | undefined;
  let editorText = "";
  let opened = false;
  let closed = false;
  let overlayDone: ((r: undefined) => void) | undefined;
  let overlayComponent: { handleInput(data: string): void } | undefined;
  const fakeTui = { requestRender: () => {}, terminal: { columns: 120, rows: 40 } };

  const ui: FleetUICtx = {
    setWidget: (_key, content) => {
      widgetFactory = content as any;
    },
    onTerminalInput: (h) => {
      inputHandler = h;
      return () => {
        inputHandler = undefined;
      };
    },
    getEditorText: () => editorText,
    notify: () => {},
    custom: ((factory: any) => {
      opened = true;
      return new Promise<undefined>((resolve) => {
        const done = (r: undefined) => {
          closed = true;
          overlayDone = undefined;
          resolve(r);
        };
        overlayDone = done;
        // Construct the overlay component so the controller wires viewerClose,
        // and keep it so tests can drive the real ConversationViewer's input.
        overlayComponent = factory(fakeTui, theme, undefined, done);
      });
    }) as FleetUICtx["custom"],
  };

  const manager = fakeManager(agents);
  const fleet = new FleetList(manager, new Map());
  fleet.setUICtx(ui);
  fleet.update();

  return {
    fleet,
    ui,
    manager,
    overlayComponent: () => overlayComponent,
    press: (data) => inputHandler?.(data),
    render: (width = 120) => (widgetFactory ? widgetFactory(fakeTui, theme).render(width) : []),
    setEditorText: (t) => {
      editorText = t;
    },
    overlayOpened: () => opened,
    overlayClosed: () => closed,
    closeOverlay: async () => {
      overlayDone?.(undefined);
      await Promise.resolve();
    },
  };
}

describe("formatFleetElapsed", () => {
  it("renders integer seconds (no decimal, no suffix)", () => {
    expect(formatFleetElapsed(0)).toBe("0s");
    expect(formatFleetElapsed(11_000)).toBe("11s");
    expect(formatFleetElapsed(11_400)).toBe("11s");
    expect(formatFleetElapsed(11_600)).toBe("12s");
  });
  it("floors negatives to 0s", () => {
    expect(formatFleetElapsed(-500)).toBe("0s");
  });
});

describe("formatFleetTokens", () => {
  it("prefixes a down-arrow and uses plural 'tokens'", () => {
    expect(formatFleetTokens(13_100)).toBe("↓ 13.1k tokens");
    expect(formatFleetTokens(950)).toBe("↓ 950 tokens");
    expect(formatFleetTokens(1_200_000)).toBe("↓ 1.2M tokens");
  });
});

describe("FleetList navigation", () => {
  it("does not register a widget when there are no agents", () => {
    const h = harness([]);
    expect(h.render()).toEqual([]);
  });

  it("activates on Ctrl+↑, consuming the key", () => {
    const h = harness([makeRecord()]);
    const res = h.press(CTRL_UP);
    expect(res).toEqual({ consume: true });
    // main selected, list active → nav hint shown
    expect(h.render().some((l) => l.includes("FleetView focused"))).toBe(true);
  });

  it("does not activate on plain arrows used by prompt history/navigation", () => {
    const h = harness([makeRecord()]);
    expect(h.press(DOWN)).toBeUndefined();
    expect(h.press(UP)).toBeUndefined();
    expect(h.press(LEFT)).toBeUndefined();
    expect(h.press(RIGHT)).toBeUndefined();
  });

  it("activates even when the prompt is non-empty", () => {
    const h = harness([makeRecord()]);
    h.setEditorText("hello");
    expect(h.press(CTRL_UP)).toEqual({ consume: true });
  });

  it("ignores key-release events so one tap moves exactly one row", () => {
    const h = harness([
      makeRecord({ id: "a1", description: "one" }),
      makeRecord({ id: "a2", description: "two" }),
    ]);
    h.press(CTRL_UP); // activate → selection on last row
    h.press(DOWN_RELEASE); // release half of the SAME tap — must be a no-op
    expect(h.render().find((l) => l.includes("two"))).toContain("▶");
    expect(h.render().find((l) => l.includes("one"))).not.toContain("▶");
  });

  it("moves selection down/up and clamps at the ends", () => {
    const agents = [
      makeRecord({ id: "a1", description: "one" }),
      makeRecord({ id: "a2", description: "two" }),
    ];
    const h = harness(agents);
    h.press(CTRL_UP); // activate → last row (a2)
    expect(h.render().find((l) => l.includes("two"))).toContain("▶");
    h.press(CTRL_UP); // → 1 (a1)
    expect(h.render().find((l) => l.includes("one"))).toContain("▶");
    h.press(CTRL_DOWN); // → 2 (a2)
    expect(h.render().find((l) => l.includes("two"))).toContain("▶");
    expect(h.press(DOWN)).toEqual({ consume: true }); // down past last exits
    expect(h.render().some((l) => l.includes("ctrl+↑ focus agents"))).toBe(true);
  });

  it("↓ below the last row deactivates (returns to the prompt)", () => {
    const h = harness([makeRecord()]);
    h.press(CTRL_UP); // activate, last row
    expect(h.press(DOWN)).toEqual({ consume: true });
    expect(h.render().some((l) => l.includes("ctrl+↑ focus agents"))).toBe(true);
  });

  it("Esc deactivates", () => {
    const h = harness([makeRecord()]);
    h.press(CTRL_UP);
    expect(h.press(ESC)).toEqual({ consume: true });
    expect(h.render().some((l) => l.includes("ctrl+↑ focus agents"))).toBe(true);
  });

  it("passes non-nav keys through and cancels navigation", () => {
    const h = harness([makeRecord()]);
    h.press(CTRL_UP);
    expect(h.press("x")).toBeUndefined();
    expect(h.render().some((l) => l.includes("ctrl+↑ focus agents"))).toBe(true);
  });

  it("ignores all input while disabled and hides the widget", () => {
    const h = harness([makeRecord()]);
    h.fleet.setEnabled(false);
    expect(h.press(DOWN)).toBeUndefined();
    expect(h.render()).toEqual([]);
  });

  it("re-arms the refresh timer when the list is re-shown (toggle off→on)", () => {
    vi.useFakeTimers();
    try {
      const agents = [makeRecord({ id: "a1" })];
      const listAgents = vi.fn(() => agents);
      const manager = { listAgents, abort: () => true } as unknown as AgentManager;
      const fleet = new FleetList(manager, new Map());
      fleet.setUICtx({
        setWidget: () => {},
        onTerminalInput: () => () => {},
        getEditorText: () => "",
        notify: () => {},
        custom: (() => new Promise<undefined>(() => {})) as FleetUICtx["custom"],
      });
      fleet.update(); // shows list, arms the timer
      fleet.setEnabled(false); // hides, clears the timer
      fleet.setEnabled(true); // re-shows — must re-arm the timer
      const before = listAgents.mock.calls.length;
      vi.advanceTimersByTime(250); // a tick should fire and re-read the roster
      expect(listAgents.mock.calls.length).toBeGreaterThan(before);
      fleet.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("FleetList rendering", () => {
  it("renders main + agent rows with cursor gutter, type, description and right-aligned stats", () => {
    const h = harness([makeRecord({ description: "Sleep then report 1" })]);
    const lines = h.render(120);
    // hint + main + one agent
    expect(lines[0]).toContain("ctrl+↑ focus agents");
    expect(lines[1]).toContain("•");
    const agentLine = lines.find((l) => l.includes("Sleep then report 1"))!;
    expect(agentLine).not.toContain("⏺");
    expect(agentLine).not.toContain("◯");
    expect(agentLine).toContain(getDisplayName("general-purpose"));
    expect(agentLine).toContain("↓ 13.1k tokens");
    expect(agentLine).toMatch(/\d+s · ↓/); // "<seconds>s · ↓ ..." (timing-agnostic)
  });

  it("orders agents earliest-launched first (top)", () => {
    const agents = [
      makeRecord({ id: "new", description: "newest", startedAt: 2000 }),
      makeRecord({ id: "old", description: "oldest", startedAt: 1000 }),
    ];
    const lines = harness(agents).render();
    const oldIdx = lines.findIndex((l) => l.includes("oldest"));
    const newIdx = lines.findIndex((l) => l.includes("newest"));
    expect(oldIdx).toBeGreaterThanOrEqual(0);
    expect(oldIdx).toBeLessThan(newIdx); // earliest sits above the later one
  });

  it("hides foreground agents", () => {
    const lines = harness([makeRecord({ isBackground: false })]).render();
    expect(lines).toEqual([]);
  });

  it("shows queued background agents even before they have a session", () => {
    const agents = [
      makeRecord({ id: "live", description: "running one" }),
      makeRecord({
        id: "pending",
        description: "queued one",
        status: "queued",
        session: undefined,
      }),
    ];
    const lines = harness(agents).render();
    expect(lines.some((l) => l.includes("running one"))).toBe(true);
    expect(lines.some((l) => l.includes("queued one"))).toBe(true);
  });

  it("collapses overflow into a '↓ N more' indicator", () => {
    const agents = Array.from({ length: 8 }, (_, i) =>
      makeRecord({ id: `a${i}`, description: `report ${i}` }),
    );
    const h = harness(agents);
    const lines = h.render(120);
    // 8 agents, cap 5 visible → "↓ 3 more"
    expect(lines.some((l) => l.includes("↓ 3 more"))).toBe(true);
  });

  it("never emits a line wider than the terminal (guards wrap-induced flicker)", () => {
    const agents = Array.from({ length: 8 }, (_, i) =>
      makeRecord({
        id: `a${i}`,
        description: `a very long agent description number ${i} that keeps going`,
      }),
    );
    const h = harness(agents);
    for (const w of [4, 8, 12, 20, 40, 80, 200]) {
      for (const line of h.render(w)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(w);
      }
    }
  });

  it("windows the visible agents so the selection stays on screen", () => {
    const agents = Array.from({ length: 8 }, (_, i) =>
      makeRecord({ id: `a${i}`, description: `report ${i}` }),
    );
    const h = harness(agents);
    h.press(CTRL_UP); // activate at last agent
    const lines = h.render(120);
    expect(lines.find((l) => l.includes("report 7"))).toContain("▶");
    expect(lines.some((l) => l.includes("↑"))).toBe(true); // hidden-above indicator
  });
});

describe("FleetList overlay lifecycle", () => {
  it("Enter on 'main' just deactivates (no overlay)", () => {
    const h = harness([makeRecord()]);
    h.press(CTRL_UP); // active at agent
    h.press(UP); // main
    h.press(ENTER);
    expect(h.overlayOpened()).toBe(false); // never opened an overlay
    expect(h.render().some((l) => l.includes("ctrl+↑ focus agents"))).toBe(true);
  });

  it("keeps the cursor on the viewed agent after closing, even if the list reordered", async () => {
    const fakeSession = { subscribe: () => () => {}, messages: [] };
    const agents = [
      makeRecord({ id: "a1", description: "one", session: fakeSession as any }),
      makeRecord({ id: "a2", description: "two", session: fakeSession as any }),
      makeRecord({ id: "a3", description: "three", session: fakeSession as any }),
    ];
    const h = harness(agents);
    h.press(CTRL_UP); // activate at a3
    h.press(UP); // a2
    h.press(ENTER); // open a2
    // a1 finishes and drops out while viewing → a2 shifts from idx 2 to idx 1.
    agents.splice(0, 1);
    await h.closeOverlay();
    // Selection follows a2 ("two") to its new position, not whatever is at idx 2 now.
    expect(h.render().find((l) => l.includes("two"))).toContain("▶");
    expect(h.render().find((l) => l.includes("three"))).not.toContain("▶");
  });

  it("wires the viewer's steer composer to manager.steer with the agent id", () => {
    const agents = [makeRecord({ id: "live", description: "the one" })];
    const h = harness(agents);
    h.press(CTRL_UP); // activate at the agent
    h.press(ENTER); // open the conversation viewer

    const viewer = h.overlayComponent();
    expect(viewer).toBeDefined();
    viewer!.handleInput("\r"); // Enter → open composer
    for (const ch of "go left") viewer!.handleInput(ch);
    viewer!.handleInput("\r"); // Enter → send

    expect(h.manager.steer).toHaveBeenCalledWith("live", "go left");
  });

  it("does NOT auto-close when the viewed agent finishes (final output stays readable)", () => {
    const agents = [makeRecord({ id: "live", description: "the one" })];
    const h = harness(agents);
    h.press(CTRL_UP); // active at the agent
    h.press(ENTER); // opens overlay
    expect(h.overlayOpened()).toBe(true);
    // The agent finishes, well past the linger window...
    agents[0] = makeRecord({
      id: "live",
      description: "the one",
      status: "completed",
      completedAt: Date.now() - 60_000,
    });
    h.fleet.onAgentFinished("live");
    expect(h.overlayClosed()).toBe(false); // viewer stays open
    expect(h.render().some((l) => l.includes("the one"))).toBe(true); // and stays listed while viewed
  });

  it("lingers a finished agent in the list, then drops it after the window", () => {
    const recent = makeRecord({
      id: "r",
      description: "recent done",
      status: "completed",
      completedAt: Date.now(),
    });
    expect(
      harness([recent])
        .render()
        .some((l) => l.includes("recent done")),
    ).toBe(true);
    const old = makeRecord({
      id: "o",
      description: "old done",
      status: "completed",
      completedAt: Date.now() - 60_000,
    });
    expect(
      harness([old])
        .render()
        .some((l) => l.includes("old done")),
    ).toBe(false);
  });
});
