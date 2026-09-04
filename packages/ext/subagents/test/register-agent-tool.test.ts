import { Container, visibleWidth } from "@earendil-works/pi-tui";
import { keyHint } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CODEX_V1_CONTRACT } from "../codex-v1-contract.js";
import { registerAgentTool } from "../register-agent-tool.js";
import { runAsSubagent } from "../subagent-context.js";

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@earendil-works/pi-coding-agent")>()),
  keyHint: vi.fn(() => "ctrl+o to expand"),
}));

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

function captureAgentTool(parentAgentType?: string) {
  let tool: any;
  const pi = {
    events: { on: vi.fn(), emit: vi.fn() },
    registerTool: vi.fn((registered) => (tool = registered)),
  };
  const noop = vi.fn();
  const register = () =>
    registerAgentTool(pi as any, {
      manager: { setMaxConcurrent: noop } as any,
      agentActivity: new Map(),
      fleet: {} as any,
      isScopeModelsEnabled: () => false,
      setScopeModelsEnabled: noop,
      setFleetViewEnabled: noop,
    });
  if (parentAgentType) runAsSubagent(parentAgentType, register);
  else register();
  return tool;
}

describe("spawn_agent", () => {
  beforeEach(() => vi.mocked(keyHint).mockReturnValue("ctrl+o to expand"));

  it("registers the pinned V1 model-facing contract", () => {
    const tool = captureAgentTool();

    expect(tool.name).toBe("spawn_agent");
    expect(tool.label).toBe("spawn_agent");
    expect(tool.description).toBe(CODEX_V1_CONTRACT.tools.spawn_agent.description);
    expect(tool.constrainedSampling).toBeUndefined();
    expect(tool.parameters.additionalProperties).toBe(false);
    expect(tool.parameters.required).toEqual(["message"]);
    expect(Object.keys(tool.parameters.properties)).toEqual([
      "message",
      "agent_type",
      "fork_context",
      "model",
      "reasoning_effort",
    ]);
    expect(JSON.parse(JSON.stringify(tool.parameters))).toEqual(
      CODEX_V1_CONTRACT.tools.spawn_agent.parameters,
    );
  });

  it("previews three prompt lines and expands to the full prompt", () => {
    const tool = captureAgentTool();
    const args = {
      agent_type: "worker",
      message: "line one\n\nline three\nline four\n",
      model: "openai/gpt-5",
      reasoning_effort: "high",
    };
    const dimTheme = {
      ...theme,
      fg: (color: string, text: string) => (color === "dim" ? `<dim>${text}</dim>` : text),
    };
    const collapsed = tool
      .renderCall(args, dimTheme, { toolCallId: "call-1", expanded: false })
      .render(200)
      .join("\n");
    const expanded = tool
      .renderCall(args, dimTheme, { toolCallId: "call-1", expanded: true })
      .render(200)
      .join("\n");

    expect(collapsed).toBe(
      "spawn_agent worker: openai/gpt-5 high\n\n" +
        "<dim>line one</dim>\n<dim>line three</dim>\n" +
        "<dim>(ctrl+o to expand)</dim>",
    );
    expect(collapsed).not.toContain("line four");
    expect(expanded).toContain("<dim>line four</dim>");
    expect(expanded.endsWith("<dim></dim>")).toBe(true);
    expect(
      tool.renderResult(
        { content: [], details: undefined },
        { expanded: false, isPartial: false },
        theme,
        { toolCallId: "call-1" },
      ),
    ).toBeInstanceOf(Container);
  });

  it("uses the configured tool-expansion binding in the collapsed hint", () => {
    vi.mocked(keyHint).mockReturnValue("alt+e to expand");
    const tool = captureAgentTool();

    const rendered = tool
      .renderCall({ message: "one\ntwo\nthree\nfour" }, theme, {
        toolCallId: "call-1",
        expanded: false,
      })
      .render(200)
      .join("\n");

    expect(keyHint).toHaveBeenCalledWith("app.tools.expand", "to expand");
    expect(rendered).toContain("(alt+e to expand)");
  });

  it("renders a bold tool name and accented role scanline", () => {
    const tool = captureAgentTool();
    const styledTheme = {
      fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
      bold: (text: string) => `<bold>${text}</bold>`,
    };

    const line = tool
      .renderCall({ agent_type: "explorer", message: "Trace the call path" }, styledTheme, {
        toolCallId: "call-1",
      })
      .render(200)[0];

    expect(line).toBe("<bold>spawn_agent</bold><accent> explorer</accent>");
  });

  it("strips terminal controls from model-controlled text", () => {
    const tool = captureAgentTool();
    const lines = tool
      .renderCall(
        {
          agent_type: "worker",
          message: "hello\u001b[31m red\nunsafe\u001b]52;c;Y29weQ==\u0007 description",
        },
        theme,
        { toolCallId: "call-1", expanded: true },
      )
      .render(200);
    const rendered = lines.join("\n");

    expect(rendered).not.toContain("\u001b");
    expect(rendered).toContain("hello red");
    expect(rendered).not.toContain("Y29weQ");
  });

  it("restores effective model metadata from persisted result details", () => {
    const tool = captureAgentTool();
    const call = tool.renderCall({ agent_type: "worker", message: "do it" }, theme, {
      toolCallId: "restored-call",
      expanded: false,
    });

    tool.renderResult(
      {
        content: [{ type: "text", text: "persisted result" }],
        details: {
          modelName: "openai/gpt-5.6",
          thinking: "xhigh",
          tags: ["isolated"],
        },
      },
      { expanded: false, isPartial: false },
      theme,
      { toolCallId: "restored-call" },
    );

    expect(call.render(200)[0]).toContain("openai/gpt-5.6 xhigh");
    expect(call.render(200)[0]).not.toContain("isolated");
  });

  it("fits every rendered line at narrow widths", () => {
    const tool = captureAgentTool();
    const lines = tool
      .renderCall({ agent_type: "worker", message: "long prompt" }, theme, {
        toolCallId: "call-1",
        expanded: false,
      })
      .render(2);

    expect(lines.every((line: string) => visibleWidth(line) <= 2)).toBe(true);
  });

  it("uses the default display when agent_type is omitted", () => {
    const tool = captureAgentTool();
    const rendered = tool
      .renderCall({ message: "do it" }, theme, {
        toolCallId: "call-1",
      })
      .render(200)
      .join("\n");

    expect(rendered).toContain("default");
    expect(rendered).not.toContain("to expand");
  });

  it("renders the inherited role for a full-history fork", () => {
    const tool = captureAgentTool("worker");

    const line = tool
      .renderCall({ message: "continue", fork_context: true }, theme, {
        toolCallId: "fork-call",
      })
      .render(200)[0];

    expect(line).toContain("spawn_agent worker");
  });

  it("shows spawn failures on the call row", async () => {
    const tool = captureAgentTool();
    const context = { toolCallId: "failed-call" };
    const call = tool.renderCall({ message: "work", agent_type: "unknown" }, theme, context);
    const result = await tool.execute(
      "failed-call",
      { message: "work", agent_type: "unknown" },
      undefined,
      undefined,
      {} as never,
    );

    tool.renderResult(result, { expanded: false, isPartial: false }, theme, context);

    expect(call.render(200).join("\n")).toContain("Error: Unknown agent_type 'unknown'.");
  });
});
