import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { renderSendInputCall, type SendInputRenderState } from "./send-input-render.js";

const theme = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  bold: (text: string) => `<bold>${text}</bold>`,
};

const plainTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

describe("send_input rendering", () => {
  it("owns one scanline for queued and interrupting submissions", () => {
    const state: SendInputRenderState = {
      recipient: "trace auth",
      message: "line one\nline two",
      interrupt: false,
      status: "queued",
    };
    expect(renderSendInputCall(state, false, theme).render(120)).toEqual([
      "<bold>send_input</bold><accent> → trace auth · queued</accent>",
      "",
      "<dim>line one</dim>",
      "<dim>line two</dim>",
    ]);

    state.interrupt = true;
    state.status = "interrupted";
    expect(renderSendInputCall(state, false, theme).render(120)[0]).toBe(
      "<bold>send_input</bold><accent> → trace auth · interrupt · interrupted</accent>",
    );
  });

  it("sanitizes model-controlled text and fits narrow widths", () => {
    const state = {
      recipient: "unsafe\u001b]52;c;Y29weQ==\u0007 agent",
      message: "hello\u001b[31m red\n".repeat(5),
      interrupt: false,
      status: "failed" as const,
      error: "bad\nINJECTED",
    };

    for (const width of [1, 2, 10]) {
      const lines = renderSendInputCall(state, false, plainTheme).render(width);
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      expect(lines.join("\n")).not.toContain("]52;");
      expect(lines.join("\n")).not.toContain("[31m");
      expect(lines.join("\n")).not.toContain("INJECTED");
    }
  });
});
