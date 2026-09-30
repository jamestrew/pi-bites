import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { registerSubagentMessageRenderer } from "../subagent-message-renderer.js";
import type { SubagentMessageDetails } from "../subagent-messages.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

const details: SubagentMessageDetails = {
  sender: {
    id: "agent-1",
    type: "explorer",
    title: "trace auth flow",
    model_name: "openai/gpt-5.4",
    thinking: "high",
  },
  message: "line one\nline two\nline three\nline four",
};

function renderer() {
  let render: any;
  registerSubagentMessageRenderer({
    registerMessageRenderer: vi.fn((_type, registered) => (render = registered)),
  } as any);
  return render;
}

describe("incoming subagent message rendering", () => {
  it("shows a three-line collapsed preview and expands to the exact message", () => {
    const collapsed = renderer()({ details }, { expanded: false }, theme).render(80);
    expect(collapsed).toEqual([
      "↳ trace auth flow sent a message (openai/gpt-5.4 high)",
      "  line one",
      "  line two",
      "  line three",
      "  (ctrl+o to expand)",
    ]);
    expect(collapsed.join("\n")).not.toContain("line four");

    const expanded = renderer()({ details }, { expanded: true }, theme).render(80);
    expect(expanded).toContain("  line four");
    expect(expanded.join("\n")).not.toContain("ctrl+o");
  });

  it("sanitizes sender/message controls and fits narrow widths", () => {
    const unsafe: SubagentMessageDetails = {
      sender: { ...details.sender, title: "bad\u001b]52;c;Y29weQ==\u0007\nINJECTED" },
      message: `safe\u001b[31m ${"x".repeat(100)}`,
    };
    for (const width of [1, 2, 3, 20]) {
      const lines = renderer()({ details: unsafe }, { expanded: false }, theme).render(width);
      expect(lines.every((line: string) => visibleWidth(line) <= width)).toBe(true);
      expect(lines.every((line: string) => !line.includes("\n"))).toBe(true);
      expect(lines.join("\n")).not.toContain("]52;");
      expect(lines.join("\n")).not.toContain("[31m");
    }
  });
});

it.each(["completed", "failed"] as const)(
  "renders V2 %s mail once with the completion scanline",
  (completion) => {
    const marked = {
      bold: (s: string) => `<b>${s}</b>`,
      fg: (c: string, s: string) => `<${c}>${s}</${c}>`,
    };
    const mail = { ...details, sender: { ...details.sender, title: "/root/work" }, completion };
    for (const expanded of [false, true]) {
      const lines = renderer()({ details: mail }, { expanded }, marked).render(120);
      expect(lines[0]).toBe(`<b>Agent</b><accent> /root/work ${completion}</accent>`);
      expect(lines[1]).toBe("");
      expect(lines[2]).toBe("<dim>line one</dim>");
      expect(lines.filter((line: string) => line.includes("line one"))).toHaveLength(1);
      expect(lines.join("\n")).not.toContain("expand");
    }
    const long = { ...mail, message: Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n") };
    const collapsed = renderer()({ details: long }, { expanded: false }, theme).render(80);
    expect(collapsed.at(-1)).toContain("expand");
    expect(collapsed).not.toContain("line 8");
    const expanded = renderer()({ details: long }, { expanded: true }, theme).render(80);
    expect(expanded).toContain("line 11");
    for (const width of [1, 12, 40])
      expect(
        renderer()({ details: long }, { expanded: false }, theme)
          .render(width)
          .every((line: string) => visibleWidth(line) <= width),
      ).toBe(true);
  },
);
