import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAgentToolParameters } from "../agent-tool-description.js";
import { getAgentConfig, registerAgents, resolveType } from "../agent-types.js";
import { resolveAgentInvocationConfig } from "../invocation-config.js";
import { registerAgentTool } from "../register-agent-tool.js";
import type { AgentConfig } from "../types.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

function foregroundGeneral(): AgentConfig {
  return {
    name: "general",
    displayName: "Foreground General",
    description: "Test fallback",
    builtinToolNames: ["read"],
    extensions: false,
    skills: false,
    systemPrompt: "Test agent",
    promptMode: "replace",
    runInBackground: false,
  };
}

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
    setDefaultJoinMode: noop,
    setScopeModelsEnabled: noop,
    setDisableDefaultAgents: noop,
    setToolDescriptionMode: noop,
    setFleetViewEnabled: noop,
    getDefaultJoinMode: () => "smart",
    trackSpawned: noop,
  });
  return tool;
}

describe("Agent call rendering", () => {
  beforeEach(() => registerAgents(new Map()));

  it("does not request strict sampling for its optional parameter schema", () => {
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
      "run_in_background",
      "isolation",
    ]);
  });

  it.each([
    ["omitted mode", undefined, true],
    ["explicit foreground", false, false],
  ])("matches execution for %s", (_name, runInBackground, expectedBackground) => {
    const args = {
      subagent_type: "general",
      description: "test",
      prompt: "do it",
      run_in_background: runInBackground,
    };
    const tool = captureAgentTool();

    const rendered = tool.renderCall(args, theme, { toolCallId: "call-1" }).render(200).join("\n");
    const executionConfig = resolveAgentInvocationConfig(getAgentConfig("general"), args);

    expect(executionConfig.runInBackground).toBe(expectedBackground);
    expect(rendered.includes("background")).toBe(expectedBackground);
  });

  it("uses the same general fallback config as execution for an unknown type", () => {
    registerAgents(new Map([["general", foregroundGeneral()]]));
    const args = { subagent_type: "unknown", description: "test", prompt: "do it" };
    const tool = captureAgentTool();

    const rendered = tool.renderCall(args, theme, { toolCallId: "call-1" }).render(200).join("\n");
    const executionType = resolveType(args.subagent_type) ?? "general";
    const executionConfig = resolveAgentInvocationConfig(getAgentConfig(executionType), {});

    expect(executionConfig.runInBackground).toBe(false);
    expect(rendered).toContain("Foreground General");
    expect(rendered).not.toContain("background");
  });
});
