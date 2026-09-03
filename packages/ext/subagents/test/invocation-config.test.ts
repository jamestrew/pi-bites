import { describe, expect, it } from "vitest";
import { resolveAgentInvocationConfig } from "../invocation-config.js";
import type { AgentConfig } from "../types.js";

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "Explore",
    description: "Explore",
    builtinToolNames: ["read"],
    extensions: false,
    skills: false,
    systemPrompt: "Test agent",
    promptMode: "replace",
    isolated: false,
    ...overrides,
  };
}

describe("resolveAgentInvocationConfig", () => {
  it("prefers public tool-call params over agent defaults", () => {
    const resolved = resolveAgentInvocationConfig(
      makeConfig({
        model: "provider/config-model",
        thinking: "high",
        isolated: false,
      }),
      {
        model: "provider/param-model",
        thinking: "minimal",
        isolated: true,
      },
    );

    expect(resolved).toMatchObject({
      modelInput: "provider/param-model",
      modelFromParams: true,
      thinking: "minimal",
      isolated: false,
    });
  });

  it("uses tool-call params when no agent config is available", () => {
    const resolved = resolveAgentInvocationConfig(undefined, {
      model: "provider/param-model",
      thinking: "minimal",
      isolated: true,
    });

    expect(resolved).toMatchObject({
      modelInput: "provider/param-model",
      modelFromParams: true,
      thinking: "minimal",
      isolated: true,
    });
  });

  it("uses an explicit agent thinking level when the tool call omits one", () => {
    const resolved = resolveAgentInvocationConfig(makeConfig({ thinking: "high" }), {});

    expect(resolved.thinking).toBe("high");
  });

  it("defaults isolation when config and params omit it", () => {
    const resolved = resolveAgentInvocationConfig(makeConfig({ isolated: undefined }), {});

    expect(resolved.isolated).toBe(false);
  });
});
