import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import {
  buildNotificationDetails,
  formatTaskNotification,
  registerNotificationRenderer,
} from "../notifications.js";
import type { AgentRecord, NotificationDetails } from "../types.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

function renderer() {
  let render: any;
  registerNotificationRenderer({
    registerMessageRenderer: vi.fn((_type, registered) => (render = registered)),
  } as any);
  return render;
}

function details(): NotificationDetails {
  return {
    id: "agent-1",
    description: "Demo delayed background task",
    status: "completed",
    toolUses: 1,
    turnCount: 0,
    totalTokens: 5_900,
    durationMs: 36_600,
    result: "response one\nresponse two\nresponse three\nresponse four",
  };
}

describe("asynchronous completion notification rendering", () => {
  it("previews three response lines when collapsed", () => {
    const output = renderer()({ details: details() }, { expanded: false }, theme)
      .render(120)
      .map((line: string) => line.trimEnd())
      .join("\n");

    expect(output).toBe(
      "✓ Demo delayed background task completed\n" +
        "  (1 tool use · 5.9k tokens · 36.6s)\n" +
        "  response one\n  response two\n  response three\n" +
        " (ctrl+o to expand)",
    );
    expect(output).not.toContain("response four");
  });

  it("dims every notification line below the heading", () => {
    const dimTheme = {
      ...theme,
      fg: (color: string, text: string) => (color === "dim" ? `<dim>${text}</dim>` : text),
    };
    const output = renderer()({ details: details() }, { expanded: false }, dimTheme).render(120);

    expect(output.slice(1)).toEqual([
      "<dim>  (1 tool use · 5.9k tokens · 36.6s)</dim>",
      "<dim>  response one</dim>",
      "<dim>  response two</dim>",
      "<dim>  response three</dim>",
      "<dim> (ctrl+o to expand)</dim>",
    ]);
  });

  it("shows the complete response when expanded", () => {
    const output = renderer()({ details: details() }, { expanded: true }, theme)
      .render(120)
      .map((line: string) => line.trimEnd())
      .join("\n");

    expect(output).toContain("  response four");
    expect(output).not.toContain("ctrl+o");
  });

  it("caps narrow collapsed previews and single-line metadata", () => {
    const unsafe = {
      ...details(),
      description: "unsafe\u001b]52;c;Y29weQ==\u0007 agent\nINJECTED",
      result: `safe\u001b[31m ${"x".repeat(100)}`,
    };

    for (const width of [1, 2, 3, 20]) {
      const output = renderer()({ details: unsafe }, { expanded: false }, theme).render(width);
      expect(output).toHaveLength(6);
      expect(output.every((line: string) => visibleWidth(line) <= width)).toBe(true);
      expect(output.every((line: string) => !line.includes("\n"))).toBe(true);
      expect(output.join("\n")).not.toContain("]52;");
      expect(output.join("\n")).not.toContain("[31m");
    }
  });

  it("strips terminal controls from the persisted notification payload", () => {
    const payload = formatTaskNotification({
      id: "agent-1",
      generation: 1,
      type: "general",
      parentSessionId: "parent",
      prompt: "prompt",
      description: "unsafe\u001b]52;c;Y29weQ==\u0007 agent",
      status: "completed",
      result: "safe\u001b[31m result",
      toolUses: 0,
      toolCalls: [],
      omittedToolCalls: 0,
      startedAt: 0,
      completedAt: 1,
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
      compactionCount: 0,
      failureHistory: [],
    });

    expect(payload).not.toContain("\u001b");
    expect(payload).toContain("unsafe agent");
    expect(payload).toContain("safe result");
  });

  it("exposes a missing final response as the same model and UI error", () => {
    const record: AgentRecord = {
      id: "agent-1",
      generation: 1,
      type: "general",
      parentSessionId: "parent",
      prompt: "prompt",
      description: "tool-only child",
      status: "error" as const,
      error: "Agent completed without a final response.",
      toolUses: 0,
      toolCalls: [],
      omittedToolCalls: 0,
      startedAt: 0,
      completedAt: 1,
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
      compactionCount: 0,
      failureHistory: [],
    };

    const payload = formatTaskNotification(record);
    const notificationDetails = buildNotificationDetails(record);
    const legacyMissingFinal = {
      ...notificationDetails,
      status: "completed",
      error: undefined,
      result: " \n",
    };
    const collapsed = renderer()({ details: legacyMissingFinal }, { expanded: false }, theme)
      .render(120)
      .join("\n");
    const expanded = renderer()({ details: legacyMissingFinal }, { expanded: true }, theme)
      .render(120)
      .join("\n");

    expect(payload).toContain("Agent completed without a final response.");
    expect(notificationDetails).toMatchObject({
      status: "error",
      error: "Agent completed without a final response.",
      result: "Agent completed without a final response.",
    });
    expect(collapsed).toContain("Agent completed without a final response.");
    expect(expanded).toContain("Agent completed without a final response.");
    expect(collapsed.split("\n")[0]).toBe("✗ tool-only child error");
  });

  it("still renders legacy preview details restored from older sessions", () => {
    const legacy = { ...details(), result: undefined, resultPreview: "legacy response" };
    const output = renderer()({ details: legacy }, { expanded: true }, theme)
      .render(120)
      .map((line: string) => line.trimEnd())
      .join("\n");

    expect(output).toContain("  legacy response");
  });
});
