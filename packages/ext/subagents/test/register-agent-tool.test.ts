import { Container, visibleWidth } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAgentToolParameters } from "../agent-tool-description.js";
import { registerAgents } from "../agent-types.js";
import { registerAgentTool } from "../register-agent-tool.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

function captureAgentTool() {
  let tool: any;
  const pi = {
    events: { on: vi.fn(), emit: vi.fn() },
    registerTool: vi.fn((registered) => (tool = registered)),
  };
  const noop = vi.fn();
  registerAgentTool(pi as any, {
    manager: { setMaxConcurrent: noop } as any,
    agentActivity: new Map(),
    fleet: {} as any,
    reloadCustomAgents: noop,
    isScopeModelsEnabled: () => false,
    getToolDescriptionMode: () => "full",
    setScopeModelsEnabled: noop,
    setDisableDefaultAgents: noop,
    setToolDescriptionMode: noop,
    setFleetViewEnabled: noop,
  });
  return tool;
}

describe("Agent call rendering", () => {
  beforeEach(() => registerAgents(new Map()));

  it("exposes only composable spawn parameters", () => {
    const tool = captureAgentTool();

    expect(tool.constrainedSampling).toBeUndefined();
    expect(tool.parameters).toEqual(getAgentToolParameters());
    expect(tool.parameters.additionalProperties).toBe(false);
    expect(tool.parameters.required).toEqual(["subagent_type", "description", "prompt"]);
    expect(Object.keys(tool.parameters.properties)).toEqual([
      "subagent_type",
      "description",
      "prompt",
      "model",
      "thinking",
      "isolation",
    ]);
  });

  it("previews three prompt lines and expands to the full prompt", () => {
    const tool = captureAgentTool();
    const args = {
      subagent_type: "general",
      description: "test agent",
      prompt: "line one\n\nline three\nline four\n",
      model: "openai/gpt-5",
      thinking: "high",
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
      "general<dim>(test agent)</dim><dim>: openai/gpt-5 · thinking: high</dim>\n" +
        "<dim>   line one</dim>\n<dim>   line three</dim>\n" +
        "<dim> (ctrl+o to expand)</dim>",
    );
    expect(collapsed).not.toContain("line four");
    expect(expanded).toContain("<dim>   line four</dim>");
    expect(expanded.endsWith("<dim>   </dim>")).toBe(true);
    expect(
      tool.renderResult(
        { content: [], details: undefined },
        { expanded: false, isPartial: false },
        theme,
        { toolCallId: "call-1" },
      ),
    ).toBeInstanceOf(Container);
  });

  it("strips terminal controls from model-controlled text", () => {
    const tool = captureAgentTool();
    const lines = tool
      .renderCall(
        {
          subagent_type: "general",
          description: "unsafe\u001b]52;c;Y29weQ==\u0007 description\nINJECTED",
          prompt: "hello\u001b[31m red",
        },
        theme,
        { toolCallId: "call-1", expanded: true },
      )
      .render(200);
    const rendered = lines.join("\n");

    expect(rendered).not.toContain("\u001b");
    expect(lines[0]).toContain("unsafe description INJECTED");
    expect(rendered).toContain("hello red");
  });

  it("restores effective model metadata from persisted result details", () => {
    const tool = captureAgentTool();
    const call = tool.renderCall(
      { subagent_type: "general", description: "test", prompt: "do it" },
      theme,
      { toolCallId: "restored-call", expanded: false },
    );

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

    expect(call.render(200)[0]).toContain("openai/gpt-5.6 · thinking: xhigh");
    expect(call.render(200)[0]).not.toContain("isolated");
  });

  it("fits every rendered line at narrow widths", () => {
    const tool = captureAgentTool();
    const lines = tool
      .renderCall({ subagent_type: "general", description: "test", prompt: "long prompt" }, theme, {
        toolCallId: "call-1",
        expanded: false,
      })
      .render(2);

    expect(lines.every((line: string) => visibleWidth(line) <= 2)).toBe(true);
  });

  it("uses the general fallback display for an unknown type", () => {
    const tool = captureAgentTool();
    const rendered = tool
      .renderCall({ subagent_type: "unknown", description: "test", prompt: "do it" }, theme, {
        toolCallId: "call-1",
      })
      .render(200)
      .join("\n");

    expect(rendered).toContain("general");
  });
});
