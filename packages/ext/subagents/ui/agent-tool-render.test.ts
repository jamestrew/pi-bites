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

test("collapsed running result shows pending bash approval", () => {
  const details: AgentDetails = {
    displayName: "General",
    description: "Deploy",
    subagentType: "general",
    toolUses: 1,
    tokens: "",
    durationMs: 10,
    status: "running",
    activity: "Waiting for bash approval · git push origin main",
    bashApprovalCommand: "git push origin main",
    toolCalls: ["Bash(git push origin main)"],
  };
  const result = {
    content: [{ type: "text", text: "working" }],
    details,
  } as AgentToolResult<AgentDetails>;

  const lines = renderAgentToolResult(
    result,
    { expanded: false, isPartial: true },
    theme,
    context,
  ).render(80);

  expect(lines.join("\n")).toContain("Waiting for bash approval · git push origin main");
  expect(lines.join("\n")).toContain("Bash(git push origin main)");
  expect(lines.join("\n")).toContain("Running… (ctrl+o to expand)");
});

test("collapsed completion includes full execution statistics", () => {
  const details: AgentDetails = {
    displayName: "General",
    description: "Implement fix",
    subagentType: "general",
    modelName: "github-copilot/gpt-5.4",
    tags: ["thinking: off"],
    toolUses: 42,
    tokens: "",
    durationMs: 70_400,
    status: "completed",
    toolCalls: Array(42).fill("Read(file.ts)"),
    lifetimeUsage: {
      input: 59_000,
      output: 4_900,
      cacheRead: 619_500,
      cacheWrite: 0,
      cost: 0.113,
    },
  };
  const result = {
    content: [{ type: "text", text: "done" }],
    details,
  } as AgentToolResult<AgentDetails>;

  const lines = renderAgentToolResult(
    result,
    { expanded: false, isPartial: false },
    theme,
    context,
  ).render(120);

  expect(lines[0]).toBe("⎿  Done (+42 more tool uses · ↑59k ↓4.9k R619.5k CH91.3% $0.113 · 70.4s)");
});
