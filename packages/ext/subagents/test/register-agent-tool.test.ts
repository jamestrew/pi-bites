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

  it("renders the agent type without foreground/background mode", () => {
    const tool = captureAgentTool();
    const rendered = tool
      .renderCall({ subagent_type: "general", description: "test", prompt: "do it" }, theme, {
        toolCallId: "call-1",
      })
      .render(200)
      .join("\n");

    expect(rendered).toContain("general");
    expect(rendered).not.toContain("background");
    expect(rendered).not.toContain("foreground");
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
