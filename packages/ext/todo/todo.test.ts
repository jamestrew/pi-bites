import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerTodoTool } from "./todo.js";

const theme = {
  fg: (_color: string, text: string) => text,
};

function renderContext() {
  return {
    args: {},
    toolCallId: crypto.randomUUID(),
    invalidate: vi.fn(),
    lastComponent: undefined,
    state: {},
    cwd: "/tmp",
    executionStarted: true,
    argsComplete: true,
    isPartial: false,
    expanded: false,
    showImages: false,
    isError: false,
  };
}

describe("todo completion rendering", () => {
  let tool: any;

  beforeEach(async () => {
    const pi = { registerTool: vi.fn((definition) => (tool = definition)) };
    registerTodoTool(pi as any);
    await tool.execute("clear", { action: "clear" }, undefined, undefined, {});
  });

  it("keeps completion summaries local to the call that completed the list", async () => {
    const first = await tool.execute(
      "create-first",
      { action: "create", subject: "First" },
      undefined,
      undefined,
      {},
    );
    const firstContext = renderContext();
    tool.renderResult(first, { expanded: false, isPartial: false }, theme, firstContext);

    const completed = await tool.execute(
      "complete-first",
      { action: "update", id: 1, status: "completed" },
      undefined,
      undefined,
      {},
    );
    const completedContext = renderContext();
    tool.renderResult(completed, { expanded: false, isPartial: false }, theme, completedContext);
    expect(tool.renderCall({}, theme, completedContext).render(120).join("\n")).toContain(
      "All 1 task completed",
    );

    const second = await tool.execute(
      "create-second",
      { action: "create", subject: "Second" },
      undefined,
      undefined,
      {},
    );
    const secondContext = renderContext();
    tool.renderResult(second, { expanded: false, isPartial: false }, theme, secondContext);

    expect(tool.renderCall({}, theme, secondContext).render(120)).toEqual([]);
    expect(tool.renderCall({}, theme, firstContext).render(120)).toEqual([]);
  });
});
