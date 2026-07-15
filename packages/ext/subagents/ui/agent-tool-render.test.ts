import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { expect, test, vi } from "vitest";

vi.mock("../agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../agent-runner.js")>("../agent-runner.js");
  return { ...actual, runAgent: vi.fn(() => new Promise(() => {})) };
});

import { AgentManager } from "../agent-manager.js";
import { createAgentToolExecute } from "../agent-tool-execute.js";
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

test.each([false, true])(
  "background launch uses completed-action wording when expanded=%s",
  (expanded) => {
    const details: AgentDetails = {
      displayName: "Explore",
      description: "Investigate failure",
      subagentType: "explore",
      toolUses: 0,
      tokens: "",
      durationMs: 10,
      status: "background",
      agentId: "208b6769-fd6b-4c1",
    };
    const result = {
      content: [{ type: "text", text: "" }],
      details,
    } as AgentToolResult<AgentDetails>;

    const output = renderAgentToolResult(result, { expanded, isPartial: false }, theme, context)
      .render(80)
      .join("\n");

    expect(output).toContain("Started in background (ID: 208b6769-fd6b-4c1)");
    if (expanded) expect(output).toContain("Started in background.");
    expect(output).not.toMatch(/running in background|background agent running/i);
  },
);

test("queued background launch renders its actual state", async () => {
  const manager = new AgentManager(undefined, 1);
  const execute = createAgentToolExecute({
    pi: { events: { emit: vi.fn() }, getThinkingLevel: () => "off" } as any,
    manager,
    agentActivity: new Map(),
    fleet: { ensureTimer: vi.fn(), update: vi.fn() } as any,
    reloadCustomAgents: vi.fn(),
    isScopeModelsEnabled: () => false,
    getDefaultJoinMode: () => "async",
    trackSpawned: vi.fn(),
  });
  const ctx = {
    cwd: "/tmp",
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: { getSessionId: () => "queued-render-test" },
  } as any;
  const params = {
    subagent_type: "general-purpose",
    description: "Investigate failure",
    prompt: "Investigate the failure",
    run_in_background: true,
  };

  try {
    await execute("running", params, undefined, undefined, ctx);
    const result = await execute("queued", params, undefined, undefined, ctx);

    expect(result.details?.status).toBe("queued");
    for (const expanded of [false, true]) {
      const output = renderAgentToolResult(result, { expanded, isPartial: false }, theme, context)
        .render(80)
        .join("\n");
      expect(output).toContain(`Queued in background (ID: ${result.details?.agentId})`);
      if (expanded) expect(output).toContain("Queued in background.");
      expect(output).not.toContain("Started in background");
    }
  } finally {
    manager.dispose();
  }
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
