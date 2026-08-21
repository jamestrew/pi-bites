import { Container } from "@earendil-works/pi-tui";
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
      prompt: "line one\nline two\nline three\nline four",
      model: "openai/gpt-5",
      thinking: "high",
    };
    const collapsed = tool
      .renderCall(args, theme, { toolCallId: "call-1", expanded: false })
      .render(200)
      .join("\n");
    const expanded = tool
      .renderCall(args, theme, { toolCallId: "call-1", expanded: true })
      .render(200)
      .join("\n");

    expect(collapsed).toBe(
      "general(test agent): openai/gpt-5 · thinking: high\n" +
        " │ line one\n │ line two\n │ line three\n (ctrl+o to expand)",
    );
    expect(collapsed).not.toContain("line four");
    expect(expanded).toContain(" │ line four");
    expect(tool.renderResult()).toBeInstanceOf(Container);
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
