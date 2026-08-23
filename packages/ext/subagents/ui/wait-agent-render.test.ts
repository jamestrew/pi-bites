import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { WaitAgentDetails, WaitAgentResult, WaitAgentSender } from "../types.js";
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

function details(
  overrides: Partial<WaitAgentDetails> & {
    sender?: WaitAgentSender;
    message?: string;
  },
): WaitAgentDetails {
  return {
    outcome: "waiting",
    timed_out: false,
    agents: [],
    wait_started_at: 10_000,
    ...overrides,
  } as WaitAgentDetails;
}

describe("WaitAgent rendering", () => {
  it("dims wait status while using whole seconds and minute timeouts", () => {
    vi.spyOn(Date, "now").mockReturnValue(10_500);
    const dimTheme: Theme = {
      ...theme,
      fg: (color, text) => (color === "dim" ? `<dim>${text}</dim>` : text),
    };
    const output = renderWaitAgent(
      details({
        timeout_ms: 240_000,
        agents: [agent({ status: "completed", result: "answer" })],
      }),
      false,
      dimTheme,
    )
      .render(120)
      .join("\n");

    expect(output).toContain("WaitAgent<dim> · waiting 0s / timeout 4m</dim>");
    expect(output).toContain("<dim> └─ ✓ Explore subagent UI flow · Done");
    expect(output).toContain("<dim>      answer</dim>");
    vi.restoreAllMocks();
  });

  it("shows live elapsed time, configured timeout, and all selected agents", () => {
    vi.spyOn(Date, "now").mockReturnValue(17_000);
    const output = renderWaitAgent(
      details({
        timeout_ms: 20_000,
        agents: [
          agent({ model_name: "openai-codex/gpt-5.6-sol", thinking: "high" }),
          agent({ id: "agent-2", description: "Trace completion delivery" }),
        ],
      }),
      false,
      theme,
    )
      .render(120)
      .join("\n");

    expect(output).toBe(
      "WaitAgent · waiting 7s / timeout 20s\n" +
        " ├─ ◷ Explore subagent UI flow (openai-codex/gpt-5.6-sol high)\n" +
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
            model_name: "openai-codex/gpt-5.6-sol",
            thinking: "high",
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
      "├─ ✓ Explore subagent UI flow · Done (openai-codex/gpt-5.6-sol high · 2 tool uses · ↑5.9k ↓900 · 12.5s)",
    );
    expect(output).toContain("│    response three");
    expect(output).not.toContain("response four");
    expect(output).toContain("└─ ◷ Trace completion delivery · still running");
    expect(output).toContain("(ctrl+o to expand)");
  });

  it("nests a three-line child message preview and expands the complete message", () => {
    const message = "line one\nline two\nline three\nline four";
    const received = details({
      outcome: "message",
      wait_ended_at: 22_400,
      timeout_ms: 30_000,
      sender: {
        id: "agent-1",
        type: "explore",
        title: "trace auth flow",
        model_name: "openai/gpt-5.4",
        thinking: "high",
      },
      message,
      agents: [agent({})],
    });

    expect(renderWaitAgent(received, false, theme).render(100)).toEqual([
      "WaitAgent · received message after 12.4s / timeout 30s",
      "  └─ ↳ trace auth flow (openai/gpt-5.4 high)",
      "      line one",
      "      line two",
      "      line three",
      "  (ctrl+o to expand)",
    ]);
    const expanded = renderWaitAgent(received, true, theme).render(100).join("\n");
    expect(expanded).toContain("      line four");
    expect(expanded).not.toContain("ctrl+o");

    for (const width of [1, 2, 3, 20]) {
      expect(
        renderWaitAgent(received, false, theme)
          .render(width)
          .every((line) => visibleWidth(line) <= width),
      ).toBe(true);
    }
  });

  it("caps collapsed output and metadata at every narrow width", () => {
    const rendered = (width: number) =>
      renderWaitAgent(
        details({
          outcome: "error",
          wait_ended_at: 11_000,
          message: "error\nINJECTED ".repeat(40),
          agents: [
            agent({
              description: "safe\nINJECTED",
              status: "completed",
              result: `safe\u001b]52;c;Y29weQ==\u0007 ${"x".repeat(100)}`,
            }),
          ],
        }),
        false,
        theme,
      ).render(width);

    for (const width of [1, 2, 3, 4, 5, 6, 20]) {
      const output = rendered(width);
      expect(output).toHaveLength(7);
      expect(output.every((line) => visibleWidth(line) <= width)).toBe(true);
      expect(output.every((line) => !line.includes("\n"))).toBe(true);
      expect(output.join("\n")).not.toContain("]52;");
    }
  });

  it("renders legacy persisted details without raw JSON or invalid durations", () => {
    const output = renderWaitAgent(
      {
        outcome: "terminal",
        timed_out: false,
        agents: [
          {
            id: "legacy",
            type: "general",
            description: "Legacy agent",
            status: "completed",
            result: "legacy result",
            tool_uses: 1,
            duration_ms: 1_000,
            total_tokens: 20,
          },
        ],
      },
      false,
      theme,
    )
      .render(80)
      .join("\n");

    expect(output).toContain("Legacy agent · Done");
    expect(output).toContain("20 tokens");
    expect(output).not.toContain("↑20");
    expect(output).toContain("legacy result");
    expect(output).not.toContain("NaN");
    expect(output).not.toContain('"outcome"');
  });

  it("shows statistics for stopped agents", () => {
    const output = renderWaitAgent(
      details({
        outcome: "terminal",
        wait_ended_at: 11_000,
        agents: [agent({ status: "stopped", tool_uses: 2 })],
      }),
      true,
      theme,
    )
      .render(120)
      .join("\n");

    expect(output).toContain("Stopped (2 tool uses");
  });

  it("shows full responses when expanded and background continuation after cancellation", () => {
    const output = renderWaitAgent(
      details({
        outcome: "cancelled",
        wait_ended_at: 17_000,
        agents: [
          agent({
            status: "completed",
            result: "one\ntwo\nthree\nfour",
            tool_calls: ["Read(src/index.ts:4-6)", "Bash(bun check)"],
          }),
          agent({ id: "agent-2", description: "Trace completion delivery" }),
        ],
      }),
      true,
      theme,
    )
      .render(120)
      .join("\n");

    expect(output).toContain("WaitAgent · cancelled after 7s");
    expect(output).toContain("│    → Read(src/index.ts:4-6)");
    expect(output).toContain("│    → Bash(bun check)");
    expect(output).toContain("│    four");
    expect(output).toContain("continues in background");
    expect(output).not.toContain("ctrl+o");
  });
});
