import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { renderMessageAgentCall, renderMessageAgentResult } from "./message-agent-render.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

describe("MessageAgent rendering", () => {
  it("renders outgoing parent and child directions with exact multiline text", () => {
    expect(renderMessageAgentCall("trace auth", "line one\nline two", theme).render(80)).toEqual([
      "MessageAgent → trace auth",
      "  line one",
      "  line two",
    ]);
    expect(renderMessageAgentCall("parent", "need a decision", theme).render(80)).toEqual([
      "MessageAgent → parent",
      "  need a decision",
    ]);
    expect(renderMessageAgentResult("queued", theme).render(80)).toEqual(["  ⎿ queued"]);
  });

  it("sanitizes controls and fits narrow widths", () => {
    for (const width of [1, 2, 10]) {
      const lines = [
        ...renderMessageAgentCall(
          "unsafe\u001b]52;c;Y29weQ==\u0007 agent",
          "hello\u001b[31m red",
          theme,
        ).render(width),
        ...renderMessageAgentResult("failed", theme).render(width),
      ];
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      expect(lines.join("\n")).not.toContain("]52;");
      expect(lines.join("\n")).not.toContain("[31m");
    }
  });
});
