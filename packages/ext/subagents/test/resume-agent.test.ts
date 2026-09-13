import { stripVTControlCharacters } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@earendil-works/pi-coding-agent")>()),
  keyHint: () => "ctrl+o to expand",
}));

import { CODEX_V1_CONTRACT } from "../codex-v1-contract.js";
import { registerResumeAgent } from "../register-resume-agent.js";

const textOf = (result: any): string => result.content[0].text;
const theme = {
  bold: (text: string) => `<bold>${text}</bold>`,
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
};

function register(manager: Record<string, unknown>) {
  let tool: any;
  const pi = { registerTool: vi.fn((registered) => (tool = registered)) } as any;
  registerResumeAgent(
    pi,
    { getClosedRecord: vi.fn(), ...manager } as any,
    () => true,
    () => new AbortController().signal,
  );
  const execute = tool.execute;
  tool.execute = (
    callId: string,
    params: unknown,
    signal?: AbortSignal,
    update?: unknown,
    ctx = {},
  ) => execute(callId, params, signal, update, ctx);
  return tool;
}

describe("resume_agent", () => {
  it.each(["execute", "context", "owner"])(
    "combines %s cancellation and snapshots active ctx",
    async (source) => {
      const controllers = {
        execute: new AbortController(),
        context: new AbortController(),
        owner: new AbortController(),
      };
      let active = true;
      const ctx = {
        get signal() {
          if (!active) throw new Error("stale ctx");
          return controllers.context.signal;
        },
      };
      let tool: any;
      const pi = { registerTool: (value: unknown) => (tool = value) } as any;
      const reopen = vi.fn(async (_pi, receivedCtx, id, options) => {
        expect(receivedCtx).toBe(ctx);
        expect(id).toBe("closed");
        expect(options.scopeModels).toBe(false);
        expect(options.signal.aborted).toBe(false);
        active = false;
        await Promise.resolve();
        controllers[source as keyof typeof controllers].abort("cancelled");
        expect(options.signal.aborted).toBe(true);
        expect(options.signal.reason).toBe("cancelled");
        return "pending_init" as const;
      });
      registerResumeAgent(
        pi,
        {
          getRecord: vi.fn(),
          getClosedRecord: vi.fn(() => ({
            id: "closed",
            recoverable: true,
            description: "saved worker",
          })) as any,
          reopen,
        },
        () => false,
        () => controllers.owner.signal,
      );
      const result = await tool.execute(
        "resume",
        { id: "closed" },
        controllers.execute.signal,
        undefined,
        ctx,
      );
      expect(JSON.parse(textOf(result))).toEqual({ status: "pending_init" });
      expect(result.details.recipient).toBe("saved worker");
      expect(reopen.mock.calls[0]?.[0]).toBe(pi);
    },
  );

  it("resolves the recipient after partial arguments finish streaming", () => {
    const manager = {
      getRecord: vi.fn((id) => (id === "agent-1" ? { description: "worker" } : undefined)),
    };
    const tool = register(manager);
    const state = {};
    const context = { toolCallId: "partial", state, expanded: false };

    expect(tool.renderCall({}, theme, context).render(80)).toEqual([
      "<bold>resume_agent</bold><accent></accent>",
    ]);
    tool.renderCall({ id: "agent" }, theme, context);
    const complete = tool.renderCall({ id: "agent-1" }, theme, context);

    expect(complete.render(80)[0]).toContain(" worker");
  });

  it("resolves closed recipients and restores saved result details without a live record", () => {
    const tool = register({
      getRecord: vi.fn(),
      getClosedRecord: vi.fn(() => ({ description: "saved worker" })),
    });
    const context = { state: {}, expanded: false };
    expect(tool.renderCall({ id: "closed" }, theme, context).render(100)).toEqual([
      "<bold>resume_agent</bold><accent> saved worker</accent>",
    ]);
    const restored = register({ getRecord: vi.fn() });
    const restoredContext = { state: {}, expanded: true };
    expect(
      restored
        .renderResult(
          {
            content: [],
            details: {
              id: "closed",
              recipient: "saved worker",
              status: "resumed",
              agentStatus: { errored: "oops" },
            },
          },
          { expanded: true },
          theme,
          restoredContext,
        )
        .render(100),
    ).toEqual([]);
    expect(restored.renderCall({ id: "closed" }, theme, restoredContext).render(100)).toEqual([
      "<bold>resume_agent</bold><accent> saved worker resumed errored</accent>",
    ]);
  });

  it("registers the pinned contract and returns the resumed status", async () => {
    const record = { id: "agent-1", description: "trace auth" };
    const manager = {
      getRecord: vi.fn(() => record),
      reopen: vi.fn(async () => "running"),
    };
    const tool = register(manager);

    expect(tool.name).toBe("resume_agent");
    expect(tool.label).toBe("resume_agent");
    expect(tool.description).toBe(CODEX_V1_CONTRACT.tools.resume_agent.description);
    expect(JSON.parse(JSON.stringify(tool.parameters))).toEqual(
      CODEX_V1_CONTRACT.tools.resume_agent.parameters,
    );

    const state = {};
    const rendered = tool.renderCall({ id: "agent-1" }, theme, {
      toolCallId: "close",
      state,
      expanded: false,
    });
    const result = await tool.execute("close", { id: "agent-1" });
    tool.renderResult(result, { expanded: false, isPartial: false }, theme, {
      toolCallId: "close",
      state,
    });

    expect(JSON.parse(textOf(result))).toEqual({ status: "running" });
    expect(rendered.render(80)).toEqual([
      "<bold>resume_agent</bold><accent> trace auth resumed running</accent>",
    ]);
  });

  it("reports completed, queued, repeated, and unknown ids deterministically", async () => {
    const reopen = vi
      .fn()
      .mockResolvedValueOnce({ completed: "done" })
      .mockResolvedValueOnce("pending_init")
      .mockResolvedValueOnce("shutdown")
      .mockRejectedValueOnce(new Error("agent with id missing not found"));
    const tool = register({
      getRecord: vi.fn((id) => ({ id, description: id })),
      reopen,
    });
    const staleCtx = Object.create(null);
    Object.defineProperty(staleCtx, "sessionManager", {
      get: () => {
        throw new Error("stale ctx");
      },
    });

    const completed = await tool.execute(
      "completed",
      { id: "completed" },
      undefined,
      undefined,
      staleCtx,
    );
    const queued = await tool.execute("queued", { id: "queued" });
    const repeated = await tool.execute("repeated", { id: "repeated" });
    await expect(tool.execute("missing", { id: "missing" })).rejects.toThrow(
      "agent with id missing not found",
    );

    expect(JSON.parse(textOf(completed))).toEqual({ status: { completed: "done" } });
    expect(JSON.parse(textOf(queued))).toEqual({ status: "pending_init" });
    expect(JSON.parse(textOf(repeated))).toEqual({ status: "shutdown" });
  });

  it.each([
    ["idle", "pending_init", "idle"],
    ["running", "running", "running"],
    ["completed", { completed: "done" }, "completed"],
  ])("renders a %s id as one styled scanline", async (_name, agentStatus, label) => {
    const tool = register({
      getRecord: vi.fn(() => ({ description: "worker" })),
      reopen: vi.fn(async () => agentStatus),
    });
    const state = {};
    const call = tool.renderCall({ id: "agent-1" }, theme, {
      toolCallId: "close",
      state,
      expanded: false,
    });
    const result = await tool.execute("close", { id: "agent-1" });
    tool.renderResult(result, { expanded: false }, theme, { toolCallId: "close", state });

    expect(call.render(80)).toEqual([
      `<bold>resume_agent</bold><accent> worker resumed ${label}</accent>`,
    ]);
  });

  it("restores a host error as one styled call row without result details", () => {
    const tool = register({ getRecord: vi.fn() });
    const context = { toolCallId: "restored-error", state: {}, expanded: false, isError: true };
    tool.renderResult(
      { content: [{ type: "text", text: "agent not found" }] },
      { expanded: false, isPartial: false },
      theme,
      context,
    );
    expect(tool.renderCall({ id: "missing" }, theme, context).render(200)).toEqual([
      "<bold>resume_agent</bold><accent> missing failed</accent>",
      "",
      "<dim>Error: agent not found</dim>",
    ]);
  });

  it.each([false, true])("renders host errors at bounded width (expanded=%s)", async (expanded) => {
    const tool = register({
      getRecord: vi.fn(),
      reopen: vi.fn(async () => Promise.reject(new Error("x".repeat(300)))),
    });
    const state = {};
    const plainTheme = {
      bold: (text: string) => text,
      fg: (_color: string, text: string) => text,
    };
    const call = tool.renderCall({ id: "missing" }, plainTheme, {
      toolCallId: "failed",
      state,
      expanded: false,
    });
    await expect(tool.execute("failed", { id: "missing" })).rejects.toThrow("x".repeat(300));
    const result = { content: [{ type: "text", text: "x".repeat(300) }], details: undefined };
    const renderedResult = tool.renderResult(result, { expanded }, plainTheme, {
      toolCallId: "failed",
      state,
      isError: true,
    });
    const rendered = tool
      .renderCall({ id: "missing" }, plainTheme, {
        toolCallId: "failed",
        state,
        expanded,
      })
      .render(24);
    expect(renderedResult.render(24)).toEqual([]);
    expect(stripVTControlCharacters(rendered[0])).toBe("resume_agent missing fa…");
    expect(rendered[1]).toBe("");
    expect(rendered.every((line: string) => visibleWidth(line) <= 24)).toBe(true);
    if (expanded) {
      expect(rendered.slice(2).map(stripVTControlCharacters).join("")).toBe(
        `Error:${"x".repeat(300)}`,
      );
    } else {
      expect(rendered).toHaveLength(11);
      expect(rendered.at(-1)).toBe("(ctrl+o to expand)");
    }
    expect(call.render(80)[0]).toContain("failed");
  });
});
