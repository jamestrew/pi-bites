import { EventEmitter } from "node:events";
import { beforeEach, expect, it, vi } from "vitest";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));

vi.mock("node:child_process", () => ({ spawn }));

import registerNotifications from "./notifications.js";

beforeEach(() => {
  spawn.mockReset();
});

it("does not notify for agent responses while automode is enabled", () => {
  const handlers = new Map<string, (event: any, ctx: any) => void>();
  const pi = {
    events: { on: vi.fn() },
    on: vi.fn((event: string, handler: (event: any, ctx: any) => void) =>
      handlers.set(event, handler),
    ),
  };

  registerNotifications(pi as never, { current: {} }, { isEnabled: () => true } as never);
  handlers.get("agent_end")?.(
    { messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }] },
    { cwd: "/tmp" },
  );

  expect(spawn).not.toHaveBeenCalled();
});

it("ignores an unavailable desktop notification executable", () => {
  const child = new EventEmitter();
  spawn.mockReturnValue(child);
  let notify: ((data: unknown) => void) | undefined;
  const pi = {
    events: {
      on: vi.fn((event: string, handler: (data: unknown) => void) => {
        if (event === "bites:notify") notify = handler;
      }),
    },
    on: vi.fn(),
  };

  registerNotifications(pi as never, { current: {} });
  notify?.({ cwd: "/tmp", message: "done" });

  expect(() => child.emit("error", new Error("ENOENT"))).not.toThrow();
});
