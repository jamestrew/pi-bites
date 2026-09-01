import { expect, it, vi } from "vitest";
import { createMessageAgent } from "../message-agent.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as any;

it("records a normal parent-scoped call/result with sent or failed status", async () => {
  const send = vi.fn(() => true);
  const tool = createMessageAgent("MessageAgent", send);
  expect(tool.promptGuidelines).toEqual([
    expect.stringMatching(/^Use MessageAgent only for/),
    expect.stringContaining("final response"),
  ]);
  expect(tool.promptGuidelines?.join("\n")).toContain("likely to change the parent's behavior");
  expect(tool.promptGuidelines?.join("\n")).toContain("requires a decision");
  expect(tool.promptGuidelines?.join("\n")).toContain("incremental or supporting findings");
  expect(tool.promptGuidelines?.join("\n")).toContain("acknowledgements");
  expect(tool.promptGuidelines?.join("\n")).toContain("wait for the final response");
  expect(tool.description).toContain("queued");
  expect(tool.description).toContain("does not interrupt");
  expect(tool.description).toContain("does not replace your required final response");
  const sent = await tool.execute(
    "call",
    { message: "need a decision" },
    undefined,
    undefined,
    {} as any,
  );

  expect(send).toHaveBeenCalledWith("need a decision");
  expect(sent.details).toEqual({ status: "sent" });
  expect(tool.renderCall?.({ message: "need a decision" }, theme, {} as any).render(80)).toEqual([
    "MessageAgent → parent",
    "  need a decision",
  ]);
  expect(
    tool.renderResult?.(sent, { expanded: false, isPartial: false }, theme, {} as any).render(80),
  ).toEqual(["  ⎿ sent"]);

  const failedTool = createMessageAgent("MessageAgent", () => false);
  const failed = await failedTool.execute(
    "call",
    { message: "blocked" },
    undefined,
    undefined,
    {} as any,
  );
  expect(failed.details).toEqual({ status: "failed" });
});
