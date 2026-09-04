import { describe, expect, it } from "vitest";
import { resolveAgentInvocationConfig } from "../invocation-config.js";
import type { AgentConfig } from "../types.js";

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "explorer",
    description: "Explore",
    builtinToolNames: ["read"],
    extensions: [],
    systemPrompt: "Test agent",
    promptMode: "replace",
    ...overrides,
  };
}

describe("resolveAgentInvocationConfig", () => {
  it("prefers public tool-call params over agent defaults", () => {
    const resolved = resolveAgentInvocationConfig(
      makeConfig({
        model: "provider/config-model",
        thinking: "high",
      }),
      {
        model: "provider/param-model",
        reasoning_effort: "minimal",
      },
    );

    expect(resolved).toMatchObject({
      modelInput: "provider/param-model",
      modelFromParams: true,
      thinking: "minimal",
    });
  });

  it("uses an explicit agent thinking level when the tool call omits one", () => {
    const resolved = resolveAgentInvocationConfig(makeConfig({ thinking: "high" }), {});

    expect(resolved.thinking).toBe("high");
  });
});
