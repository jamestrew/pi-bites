import { stripVTControlCharacters } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@earendil-works/pi-coding-agent")>()),
  keyHint: () => "ctrl+o to expand",
}));

import { CODEX_V1_CONTRACT } from "../codex-v1-contract.js";
import { createCloseAgent } from "../register-close-agent.js";

const textOf = (result: any): string => result.content[0].text;
const theme = {
  bold: (text: string) => `<bold>${text}</bold>`,
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
};

function create(manager: Record<string, unknown>) {
  return createCloseAgent(manager as any) as any;
}

describe("close_agent", () => {
  it("resolves the recipient after partial arguments finish streaming", () => {
    const manager = {
      getRecord: vi.fn((id) => (id === "agent-1" ? { description: "worker" } : undefined)),
    };
    const tool = create(manager);
    const state = {};
    const context = { toolCallId: "partial", state, expanded: false };

    expect(tool.renderCall({}, theme, context).render(80)).toEqual([
      "<bold>close_agent</bold><accent></accent>",
    ]);
    tool.renderCall({ target: "agent" }, theme, context);
    const complete = tool.renderCall({ target: "agent-1" }, theme, context);

    expect(complete.render(80)[0]).toContain(" worker");
  });

  it("defines the pinned contract and returns the pre-shutdown status", async () => {
    const record = { id: "agent-1", description: "trace auth" };
    const manager = {
      getRecord: vi.fn(() => record),
      close: vi.fn(async () => "running"),
    };
    const tool = create(manager);

    expect(tool.name).toBe("close_agent");
    expect(tool.label).toBe("close_agent");
    expect(tool.description).toBe(CODEX_V1_CONTRACT.tools.close_agent.description);
    expect(JSON.parse(JSON.stringify(tool.parameters))).toEqual(
      CODEX_V1_CONTRACT.tools.close_agent.parameters,
    );

    const state = {};
    const rendered = tool.renderCall({ target: "agent-1" }, theme, {
      toolCallId: "close",
      state,
      expanded: false,
    });
    const result = await tool.execute("close", { target: "agent-1" });
    tool.renderResult(result, { expanded: false, isPartial: false }, theme, {
      toolCallId: "close",
      state,
    });

    expect(JSON.parse(textOf(result))).toEqual({ previous_status: "running" });
    expect(rendered.render(80)).toEqual([
      "<bold>close_agent</bold><accent> trace auth closed was running</accent>",
    ]);
  });

  it("reports completed, queued, repeated, and unknown targets deterministically", async () => {
    const close = vi
      .fn()
      .mockResolvedValueOnce({ completed: "done" })
      .mockResolvedValueOnce("pending_init")
      .mockResolvedValueOnce("shutdown")
      .mockRejectedValueOnce(new Error("agent with id missing not found"));
    const tool = create({
      getRecord: vi.fn((id) => ({ id, description: id })),
      close,
    });
    const staleCtx = Object.create(null);
    Object.defineProperty(staleCtx, "sessionManager", {
      get: () => {
        throw new Error("stale ctx");
      },
    });

    const completed = await tool.execute(
      "completed",
      { target: "completed" },
      undefined,
      undefined,
      staleCtx,
    );
    const queued = await tool.execute("queued", { target: "queued" });
    const repeated = await tool.execute("repeated", { target: "repeated" });
    await expect(tool.execute("missing", { target: "missing" })).rejects.toThrow(
      "agent with id missing not found",
    );

    expect(JSON.parse(textOf(completed))).toEqual({ previous_status: { completed: "done" } });
    expect(JSON.parse(textOf(queued))).toEqual({ previous_status: "pending_init" });
    expect(JSON.parse(textOf(repeated))).toEqual({ previous_status: "shutdown" });
  });

  it.each([
    ["queued", "pending_init", "was queued"],
    ["running", "running", "was running"],
    ["completed", { completed: "done" }, "was completed"],
  ])("renders a %s target as one styled scanline", async (_name, previousStatus, label) => {
    const tool = create({
      getRecord: vi.fn(() => ({ description: "worker" })),
      close: vi.fn(async () => previousStatus),
    });
    const state = {};
    const call = tool.renderCall({ target: "agent-1" }, theme, {
      toolCallId: "close",
      state,
      expanded: false,
    });
    const result = await tool.execute("close", { target: "agent-1" });
    tool.renderResult(result, { expanded: false }, theme, { toolCallId: "close", state });

    expect(call.render(80)).toEqual([
      `<bold>close_agent</bold><accent> worker closed ${label}</accent>`,
    ]);
  });

  it("restores a host error as one styled call row without result details", () => {
    const tool = create({ getRecord: vi.fn() });
    const context = { toolCallId: "restored-error", state: {}, expanded: false, isError: true };
    tool.renderResult(
      { content: [{ type: "text", text: "agent not found" }] },
      { expanded: false, isPartial: false },
      theme,
      context,
    );
    expect(tool.renderCall({ target: "missing" }, theme, context).render(200)).toEqual([
      "<bold>close_agent</bold><accent> missing failed</accent>",
      "",
      "<dim>Error: agent not found</dim>",
    ]);
  });

  it.each([false, true])("renders host errors at bounded width (expanded=%s)", async (expanded) => {
    const tool = create({
      getRecord: vi.fn(),
      close: vi.fn(async () => Promise.reject(new Error("x".repeat(300)))),
    });
    const state = {};
    const plainTheme = {
      bold: (text: string) => text,
      fg: (_color: string, text: string) => text,
    };
    const call = tool.renderCall({ target: "missing" }, plainTheme, {
      toolCallId: "failed",
      state,
      expanded: false,
    });
    await expect(tool.execute("failed", { target: "missing" })).rejects.toThrow("x".repeat(300));
    const result = { content: [{ type: "text", text: "x".repeat(300) }], details: undefined };
    const renderedResult = tool.renderResult(result, { expanded }, plainTheme, {
      toolCallId: "failed",
      state,
      isError: true,
    });
    const rendered = tool
      .renderCall({ target: "missing" }, plainTheme, {
        toolCallId: "failed",
        state,
        expanded,
      })
      .render(24);
    expect(renderedResult.render(24)).toEqual([]);
    expect(stripVTControlCharacters(rendered[0])).toBe("close_agent missing fai…");
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
