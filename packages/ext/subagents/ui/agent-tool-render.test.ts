import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import type { AgentDetails, Theme } from "./agent-format.js";
import { renderAgentToolResult } from "./agent-tool-render.js";

const theme: Theme = {
  fg: (_color, text) => text,
  bold: (text) => text,
};

const context: Parameters<typeof renderAgentToolResult>[3] = {
  args: { prompt: "Investigate the failure" },
  toolCallId: "call-1",
  invalidate() {},
  lastComponent: undefined,
  state: undefined,
  cwd: "/tmp",
  executionStarted: true,
  argsComplete: true,
  isPartial: true,
  expanded: true,
  showImages: true,
  isError: false,
};

test("partial results render as running instead of a conflicting terminal status", () => {
  const details: AgentDetails = {
    displayName: "Explore",
    description: "Investigate failure",
    subagentType: "explore",
    toolUses: 1,
    tokens: "",
    durationMs: 10,
    status: "error",
    error: "failed",
    activity: "reading files",
  };
  const result = {
    content: [{ type: "text", text: "working" }],
    details,
  } as AgentToolResult<AgentDetails>;

  const lines = renderAgentToolResult(
    result,
    { expanded: true, isPartial: true },
    theme,
    context,
  ).render(80);

  expect(lines.join("\n")).toContain("reading files");
  expect(lines.join("\n")).toContain("Running…");
  expect(lines.join("\n")).not.toContain("Error: failed");
});
