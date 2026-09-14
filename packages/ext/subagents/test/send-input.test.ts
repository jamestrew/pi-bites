import { describe, expect, it, vi } from "vitest";
import { createSendInput } from "../register-send-input.js";
import { SubagentOperationError } from "../tool-result.js";

const textOf = (result: any): string => result.content[0].text;
const plainTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

function create(manager: Record<string, unknown>) {
  const pi = {
    events: { emit: vi.fn() },
  } as any;
  const tool: any = createSendInput(pi, manager as any);
  return { pi, tool };
}

describe("send_input", () => {
  it("resolves the recipient after partial arguments finish streaming", () => {
    const manager = {
      getRecord: vi.fn((id) => (id === "agent-1" ? { description: "worker" } : undefined)),
    };
    const { tool } = create(manager);
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
    const session = { id: "retained", steer: vi.fn(async (_message: string) => {}) };
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
      sendInput: vi.fn(async (_id, message) => {
        await session.steer(message);
        return true;
      }),
    };
    const { tool } = create(manager);

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

  it("queues before session creation, resumes completed agents, and rejects unavailable input", async () => {
    const pending = { id: "pending", description: "starting", status: "running" };
    const manager = {
      getRecord: vi.fn((id) => (id === pending.id ? pending : undefined)),
      steer: vi.fn((_id: string, _message: string) => true),
      startTurn: vi.fn((_id: string, _message: string) => true),
      cancelAndSteer: vi.fn(),
      sendInput: vi.fn(async (id, message) => {
        if (pending.status === "completed") return manager.startTurn(id, message);
        if (pending.status === "running" || pending.status === "queued")
          return manager.steer(id, message);
        return false;
      }),
    };
    const { tool } = create(manager);
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

    const empty = await tool
      .execute("empty", { target: pending.id, message: " \n" }, undefined, undefined, staleCtx)
      .catch((error: unknown) => error);
    expect(empty).toBeInstanceOf(SubagentOperationError);
    expect(empty.message).toBe("Empty message can't be sent to an agent");
    expect(empty.details.status).toBe("failed");

    const unavailable = await tool
      .execute(
        "unavailable",
        { target: pending.id, message: "now", interrupt: true },
        undefined,
        undefined,
        staleCtx,
      )
      .catch((error: unknown) => error);
    expect(unavailable).toBeInstanceOf(SubagentOperationError);
    expect(unavailable.message).toContain("unavailable for interruption");
    expect(unavailable.details.status).toBe("failed");

    const missing = await tool
      .execute("missing", { target: "missing", message: "hello" }, undefined, undefined, staleCtx)
      .catch((error: unknown) => error);
    expect(missing).toBeInstanceOf(SubagentOperationError);
    expect(missing.message).toBe("agent with id missing not found");
    expect(missing.details.status).toBe("failed");

    pending.status = "completed";
    const resumed = await tool.execute(
      "completed",
      { target: pending.id, message: "continue" },
      undefined,
      undefined,
      staleCtx,
    );
    expect(JSON.parse(textOf(resumed))).toEqual({ submission_id: expect.any(String) });
    expect(manager.startTurn).toHaveBeenCalledWith(pending.id, "continue");

    for (const status of ["stopped", "error"] as const) {
      pending.status = status;
      const terminal = await tool
        .execute(status, { target: pending.id, message: "hello" }, undefined, undefined, staleCtx)
        .catch((error: unknown) => error);
      expect(terminal).toBeInstanceOf(SubagentOperationError);
      expect(terminal.message).toContain(`input was not submitted to agent ${pending.id}`);
      expect(terminal.details.status).toBe("failed");
    }
  });

  it("reports a live steering rejection instead of acknowledging dropped input", async () => {
    const session = { steer: vi.fn(async () => Promise.reject(new Error("blocked"))) };
    const record = { id: "agent-1", description: "worker", status: "running", session };
    const manager = {
      getRecord: vi.fn(() => record),
      sendInput: vi.fn(async () => {
        throw new Error("blocked");
      }),
    };
    const { tool } = create(manager);

    const rejected = await tool
      .execute(
        "rejected",
        { target: record.id, message: "next boundary" },
        undefined,
        undefined,
        {},
      )
      .catch((error: unknown) => error);

    expect(rejected).toBeInstanceOf(SubagentOperationError);
    expect(rejected.message).toContain("input was not submitted to agent agent-1: blocked");
    expect(rejected.details.status).toBe("failed");
    expect(manager.sendInput).toHaveBeenCalledOnce();
  });

  it("reports interrupt failure without issuing a submission id", async () => {
    const record = {
      id: "agent-1",
      description: "worker",
      status: "running",
      session: { abort: vi.fn() },
    };
    const manager = {
      getRecord: vi.fn(() => record),
      cancelAndSteer: vi.fn(async () => false),
    };
    const { pi, tool } = create(manager);

    const failed = await tool
      .execute(
        "interrupt",
        { target: record.id, message: "change course", interrupt: true },
        undefined,
        undefined,
        {},
      )
      .catch((error: unknown) => error);

    expect(failed).toBeInstanceOf(SubagentOperationError);
    expect(failed.message).toBe(`agent with id ${record.id} could not be interrupted`);
    expect(failed.details).toMatchObject({ status: "failed", interrupt: true });
    expect(failed.details.submissionId).toBeUndefined();
    expect(pi.events.emit).not.toHaveBeenCalled();
  });
});
