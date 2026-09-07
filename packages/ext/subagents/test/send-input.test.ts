import { describe, expect, it, vi } from "vitest";
import { registerSendInput } from "../register-send-input.js";

const textOf = (result: any): string => result.content[0].text;
const plainTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

function register(manager: Record<string, unknown>) {
  let tool: any;
  const pi = {
    registerTool: vi.fn((registered) => (tool = registered)),
    events: { emit: vi.fn() },
  } as any;
  registerSendInput(pi, manager as any);
  return { pi, tool };
}

describe("send_input", () => {
  it("resolves the recipient after partial arguments finish streaming", () => {
    const manager = {
      getRecord: vi.fn((id) => (id === "agent-1" ? { description: "worker" } : undefined)),
    };
    const { tool } = register(manager);
    const state = {};
    const context = { toolCallId: "partial", state, expanded: false };

    tool.renderCall({ target: "agent" }, plainTheme, context);
    const complete = tool.renderCall(
      { target: "agent-1", message: "continue" },
      plainTheme,
      context,
    );

    expect(complete.render(80)[0]).toBe("send_input → worker");
  });

  it("uses the pinned contract and submits queued and interrupting input", async () => {
    const session = { id: "retained", steer: vi.fn(async () => {}) };
    const record = { id: "agent-1", description: "worker", status: "running", session };
    const calls: string[] = [];
    const manager = {
      getRecord: vi.fn(() => record),
      steer: vi.fn(() => {
        calls.push("queue");
        return true;
      }),
      cancelAndSteer: vi.fn((_id, message) => {
        calls.push("interrupt");
        calls.push(`redirect:${message}`);
        return true;
      }),
    };
    const { tool } = register(manager);

    expect(tool.name).toBe("send_input");
    expect(tool.description).toContain("Use interrupt=true to redirect work immediately");
    expect(tool.parameters.required).toEqual(["target", "message"]);
    expect(Object.keys(tool.parameters.properties)).toEqual(["target", "message", "interrupt"]);
    expect(tool.parameters.additionalProperties).toBe(false);

    const renderState = {};
    const rendered = tool.renderCall(
      { target: record.id, message: "change course", interrupt: true },
      { fg: (_color: string, text: string) => text, bold: (text: string) => text },
      { toolCallId: "interrupt", state: renderState, expanded: false },
    );

    const queued = await tool.execute(
      "queued",
      { target: record.id, message: "next boundary" },
      undefined,
      undefined,
      {},
    );
    expect(JSON.parse(textOf(queued))).toEqual({ submission_id: expect.any(String) });
    expect(queued.details).toMatchObject({ status: "queued", interrupt: false });

    const interrupted = await tool.execute(
      "interrupt",
      { target: record.id, message: "change course", interrupt: true },
      undefined,
      undefined,
      {},
    );
    expect(JSON.parse(textOf(interrupted))).toEqual({ submission_id: expect.any(String) });
    expect(interrupted.details).toMatchObject({ status: "interrupted", interrupt: true });
    expect(session.steer).toHaveBeenCalledWith("next boundary");
    expect(calls).toEqual(["interrupt", "redirect:change course"]);
    tool.renderResult(
      interrupted,
      { expanded: false, isPartial: false },
      { fg: (_color: string, text: string) => text, bold: (text: string) => text },
      { toolCallId: "interrupt", state: renderState },
    );
    expect(rendered.render(80)).toEqual([
      "send_input → worker · interrupt · interrupted",
      "",
      "change course",
    ]);
  });

  it("queues before session creation and reports invalid, unavailable, and terminal input", async () => {
    const pending = { id: "pending", description: "starting", status: "running" };
    const manager = {
      getRecord: vi.fn((id) => (id === pending.id ? pending : undefined)),
      steer: vi.fn(() => true),
      cancelAndSteer: vi.fn(),
    };
    const { tool } = register(manager);
    const staleCtx = Object.create(null);
    Object.defineProperty(staleCtx, "sessionManager", {
      get: () => {
        throw new Error("stale ctx");
      },
    });

    const queued = await tool.execute(
      "pending",
      { target: pending.id, message: "queued early" },
      undefined,
      undefined,
      staleCtx,
    );
    expect(JSON.parse(textOf(queued))).toEqual({ submission_id: expect.any(String) });
    expect(manager.steer).toHaveBeenCalledWith(pending.id, "queued early");

    const empty = await tool.execute(
      "empty",
      { target: pending.id, message: " \n" },
      undefined,
      undefined,
      staleCtx,
    );
    expect(textOf(empty)).toBe("Empty message can't be sent to an agent");

    const unavailable = await tool.execute(
      "unavailable",
      { target: pending.id, message: "now", interrupt: true },
      undefined,
      undefined,
      staleCtx,
    );
    expect(textOf(unavailable)).toContain("unavailable for interruption");

    const missing = await tool.execute(
      "missing",
      { target: "missing", message: "hello" },
      undefined,
      undefined,
      staleCtx,
    );
    expect(textOf(missing)).toBe("agent with id missing not found");

    for (const status of ["completed", "stopped", "error"] as const) {
      pending.status = status;
      const terminal = await tool.execute(
        status,
        { target: pending.id, message: "hello" },
        undefined,
        undefined,
        staleCtx,
      );
      expect(textOf(terminal)).toContain(`unavailable (status: ${status})`);
    }
  });

  it("reports a live steering rejection instead of acknowledging dropped input", async () => {
    const session = { steer: vi.fn(async () => Promise.reject(new Error("blocked"))) };
    const record = { id: "agent-1", description: "worker", status: "running", session };
    const manager = {
      getRecord: vi.fn(() => record),
      steer: vi.fn(() => true),
    };
    const { tool } = register(manager);

    const rejected = await tool.execute(
      "rejected",
      { target: record.id, message: "next boundary" },
      undefined,
      undefined,
      {},
    );

    expect(textOf(rejected)).toContain("input was not submitted to agent agent-1: blocked");
    expect(rejected.details.status).toBe("failed");
    expect(manager.steer).not.toHaveBeenCalled();
  });
});
