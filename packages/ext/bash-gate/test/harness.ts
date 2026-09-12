import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { vi } from "vitest";
import registerBashGate from "../index.js";
export function subagentEntry(data: Record<string, unknown>): SessionEntry {
  return {
    type: "custom",
    id: "id",
    parentId: null,
    timestamp: "now",
    customType: "pi-bites:subagent",
    data: { type: "Explore", title: "Explore", ...data },
  };
}

export function createBashGateHarness(
  entries: SessionEntry[] = [],
  yolo = false,
  autoMode?: Omit<NonNullable<Parameters<typeof registerBashGate>[2]>, "setEnabled"> &
    Partial<Pick<NonNullable<Parameters<typeof registerBashGate>[2]>, "setEnabled">>,
  hasUI = true,
  config: Parameters<typeof registerBashGate>[1]["current"] = {},
) {
  let toolCallSequence = 0;
  const handlers = new Map<string, (event: any, ctx: any) => unknown>();
  const eventHandlers = new Map<string, (data: unknown) => void>();
  const emit = vi.fn((event: string, data: any) => {
    eventHandlers.get(event)?.(data);
  });
  let shortcutHandler: ((ctx: any) => unknown) | undefined;
  const pi = {
    registerFlag: vi.fn(),
    registerShortcut: vi.fn((_key: string, options: { handler: (ctx: any) => unknown }) => {
      shortcutHandler = options.handler;
    }),
    getFlag: vi.fn(() => yolo),
    appendEntry: vi.fn((customType: string, data: unknown) =>
      entries.push({ type: "custom", customType, data } as SessionEntry),
    ),
    on: vi.fn((event: string, handler: (event: any, ctx: any) => unknown) => {
      handlers.set(event, handler);
    }),
    events: {
      emit,
      on: vi.fn((event: string, handler: (data: unknown) => void) => {
        eventHandlers.set(event, handler);
        return () => eventHandlers.delete(event);
      }),
    },
  };
  const ui = {
    input: vi.fn(async () => undefined as string | undefined),
    notify: vi.fn(),
    select: vi.fn(async () => "Deny"),
    setStatus: vi.fn(),
  };
  const ctx = {
    cwd: "/repo",
    hasUI,
    ui,
    sessionManager: { getEntries: () => entries },
  };

  const gate = registerBashGate(
    pi as any,
    { current: config },
    autoMode && { setEnabled: vi.fn(), ...autoMode },
  );
  handlers.get("session_start")?.({}, ctx);

  return {
    gate,
    pi,
    ctx,
    ui,
    eventHandlers,
    sessionStart: () => handlers.get("session_start")?.({}, ctx),
    sessionShutdown: () => handlers.get("session_shutdown")?.({}, ctx),
    beforeTree: () => handlers.get("session_before_tree")?.({}, ctx),
    toggleYolo: () => shortcutHandler?.(ctx),
    toolCall: (event: any, context: any) =>
      handlers.get("tool_call")!(
        { toolCallId: `tool-call-${++toolCallSequence}`, ...event },
        context,
      ),
  };
}
