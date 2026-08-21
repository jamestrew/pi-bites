import { describe, expect, it, vi } from "vitest";
import type { WaitAgentDetails, WaitAgentResult } from "../types.js";
import type { Theme } from "./agent-format.js";
import { renderWaitAgent } from "./wait-agent-render.js";

const theme: Theme = {
  fg: (_color, text) => text,
  bold: (text) => text,
};

function agent(overrides: Partial<WaitAgentResult>): WaitAgentResult {
  return {
    id: "agent-1",
    type: "explore",
    description: "Explore subagent UI flow",
    status: "running",
    tool_uses: 0,
    duration_ms: 7_000,
    total_tokens: 0,
    lifetime_usage: { input: 0, output: 0, cacheWrite: 0 },
    ...overrides,
  };
}

function details(overrides: Partial<WaitAgentDetails>): WaitAgentDetails {
  return {
    outcome: "waiting",
    timed_out: false,
    agents: [],
    wait_started_at: 10_000,
    ...overrides,
  };
}

describe("WaitAgent rendering", () => {
  it("shows live elapsed time, configured timeout, and all selected agents", () => {
    vi.spyOn(Date, "now").mockReturnValue(17_000);
    const output = renderWaitAgent(
      details({
        timeout_ms: 20_000,
        agents: [agent({}), agent({ id: "agent-2", description: "Trace completion delivery" })],
      }),
      false,
      theme,
    )
      .render(120)
      .join("\n");

    expect(output).toBe(
      "WaitAgent · waiting 7s / timeout 20s\n" +
        " ├─ ◷ Explore subagent UI flow\n" +
        " └─ ◷ Trace completion delivery",
    );
    vi.restoreAllMocks();
  });

  it("previews three lines for completed agents and keeps running siblings visible", () => {
    const output = renderWaitAgent(
      details({
        outcome: "terminal",
        wait_ended_at: 25_000,
        timeout_ms: 20_000,
        agents: [
          agent({
            status: "completed",
            result: "response one\nresponse two\nresponse three\nresponse four",
            tool_uses: 2,
            duration_ms: 12_500,
            lifetime_usage: { input: 5_900, output: 900, cacheWrite: 0 },
          }),
          agent({ id: "agent-2", description: "Trace completion delivery" }),
        ],
      }),
      false,
      theme,
    )
      .render(120)
      .join("\n");

    expect(output).toContain("WaitAgent · waited 15s / timeout 20s");
    expect(output).toContain(
      "├─ ✓ Explore subagent UI flow · Done (2 tool uses · ↑5.9k ↓900 · 12.5s)",
    );
    expect(output).toContain("│  │ response three");
    expect(output).not.toContain("response four");
    expect(output).toContain("└─ ◷ Trace completion delivery · still running");
    expect(output).toContain("(ctrl+o to expand)");
  });

  it("shows full responses when expanded and background continuation after cancellation", () => {
    const output = renderWaitAgent(
      details({
        outcome: "cancelled",
        wait_ended_at: 17_000,
        agents: [
          agent({ status: "completed", result: "one\ntwo\nthree\nfour" }),
          agent({ id: "agent-2", description: "Trace completion delivery" }),
        ],
      }),
      true,
      theme,
    )
      .render(120)
      .join("\n");

    expect(output).toContain("WaitAgent · cancelled after 7s");
    expect(output).toContain("│  │ four");
    expect(output).toContain("continues in background");
    expect(output).not.toContain("ctrl+o");
  });
});
