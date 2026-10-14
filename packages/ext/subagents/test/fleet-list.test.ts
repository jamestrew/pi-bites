import { getKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentManager } from "../agent-manager.js";
import type { AgentRecord } from "../types.js";
import { getDisplayName } from "../ui/agent-format.js";
import { FleetList, formatFleetElapsed, formatFleetTokens } from "../ui/fleet-list.js";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const fleets: FleetList[] = [];
afterEach(() => {
  for (const fleet of fleets.splice(0)) fleet.dispose();
  vi.useRealTimers();
});

function makeRecord(over: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "a1",
    type: "worker",
    description: "inspect files",
    status: "running",
    startedAt: Date.now(),
    session: { subscribe: () => () => {}, messages: [] },
    lifetimeUsage: { input: 13100, output: 0, cacheWrite: 0 },
    ...over,
  } as AgentRecord;
}

function harness(agents: AgentRecord[]) {
  let widget: { render(width: number): string[] } | undefined;
  const tui = { requestRender: vi.fn() };
  const ui = {
    setWidget: vi.fn((_key, factory, options) => {
      expect(options ?? { placement: "aboveEditor" }).toEqual({ placement: "aboveEditor" });
      widget = factory?.(tui, theme);
    }),
    onTerminalInput: vi.fn(),
    custom: vi.fn(),
  };
  const fleet = new FleetList({ listAgents: () => agents } as AgentManager);
  fleets.push(fleet);
  fleet.setUICtx(ui);
  fleet.update();
  return { fleet, ui, tui, render: (width = 120) => widget?.render(width) ?? [] };
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

describe("read-only Fleet", () => {
  it("renders status without input hooks, overlays or host keybinding changes", () => {
    const bindings = structuredClone(getKeybindings().getUserBindings());
    const h = harness([makeRecord()]);
    const lines = h.render();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("main");
    expect(lines[1]).toContain(getDisplayName("worker"));
    expect(lines[1]).toContain("inspect files · running");
    expect(lines[1]).toContain("0s · ↓ 13.1k tokens");
    expect(lines.join("\n")).not.toMatch(/focus|select|enter|▶/);
    expect(h.ui.onTerminalInput).not.toHaveBeenCalled();
    expect(h.ui.custom).not.toHaveBeenCalled();
    expect(getKeybindings().getUserBindings()).toEqual(bindings);
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

  it("shows queued agents even before they have a session", () => {
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
    expect(lines).toHaveLength(7);
    expect(lines.join("\n")).not.toContain("report 5");
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

  it.each([
    ["idle", undefined, "idle"],
    ["queued", undefined, "queued"],
    ["completed", undefined, "completed"],
    ["error", undefined, "errored"],
    ["stopped", "interrupt", "interrupted"],
    ["stopped", "shutdown", "shutdown"],
  ] as const)("shows %s lifecycle status", (status, source, label) => {
    const record = makeRecord({
      status,
      completedAt: status === "idle" || status === "queued" ? undefined : Date.now(),
      ...(source ? { abort: { timestamp: Date.now(), source, reason: source } } : {}),
    });
    expect(harness([record]).render().join("\n")).toContain(` · ${label}`);
  });

  it("shows unloaded residency and pending mail without loading the conversation", () => {
    const record = makeRecord({
      status: "idle",
      session: undefined,
      retainedConversation: { entries: [] } as any,
    });
    const h = harness([record]);
    h.fleet.setPendingMail(record.id, 2);
    expect(h.render(160).join("\n")).toContain("idle · unloaded · 2 pending messages");
  });

  it("ticks elapsed time and usage, re-arms after enabling, and removes the widget on dispose", () => {
    vi.useFakeTimers();
    const record = makeRecord();
    const h = harness([record]);
    h.fleet.setEnabled(false);
    expect(h.render()).toEqual([]);
    h.fleet.setEnabled(true);
    vi.advanceTimersByTime(1000);
    expect(h.render().join("\n")).toContain("1s · ↓ 13.1k tokens");
    record.lifetimeUsage = { input: 100, output: 200, cacheWrite: 50 };
    vi.advanceTimersByTime(200);
    expect(h.render().join("\n")).toContain("↓ 350 tokens");
    expect(h.tui.requestRender).toHaveBeenCalled();
    h.fleet.dispose();
    expect(h.render()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("freezes finished elapsed time and clears the row after its linger window", () => {
    vi.useFakeTimers();
    const record = makeRecord({
      startedAt: Date.now() - 10_000,
      status: "completed",
      completedAt: Date.now(),
    });
    const h = harness([record]);
    expect(h.render().join("\n")).toContain("10s · ↓ 13.1k tokens");
    vi.advanceTimersByTime(400);
    expect(h.render().join("\n")).toContain("10s · ↓ 13.1k tokens");
    vi.advanceTimersByTime(200);
    expect(h.render()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("sanitizes descriptions so they cannot add rows or terminal escapes", () => {
    const h = harness([makeRecord({ description: "inspect\nfiles\x1b]2;owned\x07" })]);
    expect(h.render()).toHaveLength(2);
    for (const control of ["\n", "\x1b", "\x07"]) {
      expect(h.render()[1]).not.toContain(control);
    }
  });
});

it("expires completed rows without discarding pending mail for a later turn", () => {
  const record = makeRecord();
  const h = harness([record]);
  try {
    h.fleet.setPendingMail(record.id, 1);
    expect(h.render(150).join("\n")).toContain("1 pending message");

    record.status = "completed";
    record.completedAt = Date.now();
    h.fleet.onAgentFinished();
    expect(h.render(150).join("\n")).toContain("1 pending message");

    record.completedAt = Date.now() - 60_000;
    h.fleet.update();
    expect(h.render(150)).toEqual([]);

    record.status = "running";
    h.fleet.update();
    expect(h.render(150).join("\n")).toContain("1 pending message");
  } finally {
    h.fleet.dispose();
  }
});

it("distinguishes an interrupted turn from shutdown in the retained Fleet row", () => {
  const record = makeRecord({
    status: "stopped",
    completedAt: Date.now(),
    abort: { source: "interrupt", timestamp: Date.now(), reason: "interrupt" },
  });
  const h = harness([record]);
  try {
    expect(h.render(160).join("\n")).toContain("interrupted");
    record.abort = undefined;
    expect(h.render(160).join("\n")).toContain("shutdown");
  } finally {
    h.fleet.dispose();
  }
});
