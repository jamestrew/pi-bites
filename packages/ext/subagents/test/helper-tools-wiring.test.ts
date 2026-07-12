import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../agent-runner.js")>("../agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../agent-runner.js";
import subagentsExtension from "../index.js";

function makePi(active = ["Agent", "read"]) {
  const tools = new Map<string, any>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((t: any) => tools.set(t.name, t)),
    registerCommand: vi.fn(),
    on: vi.fn(),
    events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
    getActiveTools: vi.fn(() => active),
    setActiveTools: vi.fn((next: string[]) => (active = next)),
  } as any;
  return { pi, tools, active: () => active };
}

function ctx() {
  return {
    hasUI: false,
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
    cwd: "/tmp",
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: { getSessionId: vi.fn(() => "s1"), getBranch: vi.fn(() => []) },
    getSystemPrompt: vi.fn(() => "parent"),
  } as any;
}

const textOf = (r: any): string => r.content[0].text;
const theme = { fg: (_color: string, s: string) => s };

describe("background helper tools", () => {
  afterEach(() => vi.restoreAllMocks());

  it("toggle with actionable background records only", async () => {
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "done result",
      session: { dispose: vi.fn() } as any,
    });
    const { pi, tools, active } = makePi();
    subagentsExtension(pi);

    expect(active()).toEqual(["Agent", "read"]);

    await tools
      .get("Agent")
      .execute(
        "fg",
        { prompt: "go", description: "fg", subagent_type: "general-purpose" },
        undefined,
        undefined,
        ctx(),
      );
    expect(active()).toEqual(["Agent", "read"]);

    const spawn = await tools.get("Agent").execute(
      "bg",
      {
        prompt: "go",
        description: "bg",
        subagent_type: "general-purpose",
        run_in_background: true,
      },
      undefined,
      undefined,
      ctx(),
    );
    expect(active()).toEqual(["Agent", "read", "get_subagent_result", "steer_subagent"]);

    const id = textOf(spawn).match(/Agent ID: (\S+)/)?.[1];
    let out = "";
    for (let i = 0; i < 10; i++) {
      out = textOf(
        await tools
          .get("get_subagent_result")
          .execute("r", { agent_id: id }, undefined, undefined, ctx()),
      );
      if (out.includes("done result")) break;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(out).toContain("done result");
    expect(active()).toEqual(["Agent", "read"]);
  });

  it("renders helper tool results compactly until expanded", () => {
    const real = makePi();
    subagentsExtension(real.pi);
    const rendered = real.tools
      .get("get_subagent_result")
      .renderResult(
        {
          content: [{ type: "text", text: "FULL\n" + "x".repeat(500) }],
          details: {
            kind: "get_result",
            agentId: "a1",
            type: "explore",
            status: "completed",
            stats: "Tool uses: 8",
            description: "d",
            preview: "short",
          },
        },
        { expanded: false },
        theme,
      )
      .render(80)
      .join("\n");

    expect(rendered).toContain("a1: explore | completed");
    expect(rendered).toContain("short");
    expect(rendered).not.toContain("xxxxx");
    expect(rendered).toContain("ctrl+o");
  });
});
