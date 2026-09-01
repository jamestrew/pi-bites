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
    inheritContext: false,
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
        inheritContext: false,
        isolated: false,
        isolation: "worktree",
      }),
      {
        model: "provider/param-model",
        thinking: "minimal",
        inherit_context: true,
        isolated: true,
        isolation: "worktree",
      },
    );

    expect(resolved).toMatchObject({
      modelInput: "provider/param-model",
      modelFromParams: true,
      thinking: "minimal",
      inheritContext: true,
      isolated: false,
      isolation: "worktree",
    });
  });

  it("uses tool-call params when no agent config is available", () => {
    const resolved = resolveAgentInvocationConfig(undefined, {
      model: "provider/param-model",
      thinking: "minimal",
      inherit_context: true,
      isolated: true,
      isolation: "worktree",
    });

    expect(resolved).toMatchObject({
      modelInput: "provider/param-model",
      modelFromParams: true,
      thinking: "minimal",
      inheritContext: true,
      isolated: true,
      isolation: "worktree",
    });
  });

  it("uses an explicit agent thinking level when the tool call omits one", () => {
    const resolved = resolveAgentInvocationConfig(makeConfig({ thinking: "high" }), {});

    expect(resolved.thinking).toBe("high");
  });

  it("defaults boolean options when config and params omit them", () => {
    const resolved = resolveAgentInvocationConfig(
      makeConfig({ inheritContext: undefined, isolated: undefined }),
      {},
    );

    expect(resolved.inheritContext).toBe(false);
    expect(resolved.isolated).toBe(false);
  });
});
