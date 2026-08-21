import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { registerNotificationRenderer } from "../notifications.js";
import type { NotificationDetails } from "../types.js";

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
        "  1 tool use · 5.9k tokens · 36.6s\n" +
        " │ response one\n │ response two\n │ response three\n" +
        " (ctrl+o to expand)",
    );
    expect(output).not.toContain("response four");
  });

  it("shows the complete response when expanded", () => {
    const output = renderer()({ details: details() }, { expanded: true }, theme)
      .render(120)
      .map((line: string) => line.trimEnd())
      .join("\n");

    expect(output).toContain(" │ response four");
    expect(output).not.toContain("ctrl+o");
  });

  it("caps narrow collapsed previews to three physical lines and strips terminal controls", () => {
    const unsafe = {
      ...details(),
      description: "unsafe\u001b]52;c;Y29weQ==\u0007 agent",
      result: `safe\u001b[31m ${"x".repeat(100)}`,
    };
    const output = renderer()({ details: unsafe }, { expanded: false }, theme).render(20);

    expect(output).toHaveLength(6);
    expect(output.every((line: string) => visibleWidth(line) <= 20)).toBe(true);
    expect(output.join("\n")).not.toContain("]52;");
    expect(output.join("\n")).not.toContain("[31m");
  });

  it("still renders legacy preview details restored from older sessions", () => {
    const legacy = { ...details(), result: undefined, resultPreview: "legacy response" };
    const output = renderer()({ details: legacy }, { expanded: true }, theme)
      .render(120)
      .map((line: string) => line.trimEnd())
      .join("\n");

    expect(output).toContain(" │ legacy response");
  });
});
