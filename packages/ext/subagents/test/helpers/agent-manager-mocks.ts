import { vi } from "vitest";
import { runAgent } from "../../agent-runner.js";

// Importers must register `vi.mock("../agent-runner.js")` themselves; vi.mock is
// hoisted per test file, not inherited from this module.

export const mockPi = { events: { emit: vi.fn() } } as any;

export const mockCtx = {
  cwd: "/tmp",
  model: undefined,
  getSystemPrompt: () => "parent prompt",
  modelRegistry: {
    getAvailable: () => [],
    getRegisteredProviderIds: () => [],
    getRegisteredProviderConfig: () => undefined,
  },
  sessionManager: { getSessionId: () => "parent-session", getBranch: () => [] },
} as any;

export const mockSession = () => {
  const subscribers = new Set<(event: any) => void>();
  return {
    sessionManager: { getSessionId: () => "child-session" },
    abort: vi.fn(async () => {}),
    clearQueue: vi.fn(() => ({ steering: [], followUp: [] })),
    dispose: vi.fn(),
    extensionRunner: { emit: vi.fn(async () => {}) },
    followUp: vi.fn(async () => {}),
    steer: vi.fn(async () => {}),
    subscribe: (fn: (event: any) => void) => {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    emitEvent: (event: { type: string }) => {
      for (const fn of subscribers) fn(event);
    },
  } as any;
};

export const resolvedRun = () =>
  vi.mocked(runAgent).mockResolvedValue({
    responseText: "done",
    session: mockSession(),
  });

export function waitForCancellation(signal?: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    const cancel = () => reject(new Error("cancelled"));
    if (signal?.aborted) cancel();
    else signal?.addEventListener("abort", cancel, { once: true });
  });
}

export function mockPendingRun(): void {
  vi.mocked(runAgent).mockImplementation((_parent, _type, _prompt, options) => {
    const session = mockSession();
    options.onSessionCreated?.(session);
    session.emitEvent({ type: "agent_start" });
    return waitForCancellation(options.signal).finally(() =>
      session.emitEvent({ type: "agent_settled" }),
    );
  });
}
