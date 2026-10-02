import { describe, expect, it } from "vitest";
import { resolveAgent, resolveSpawnAgent } from "../agent-types.js";
import { DEFAULT_AGENTS } from "../default-agents.js";
import { SUBAGENT_TYPES } from "../types.js";

describe("embedded agent types", () => {
  it("validates inherited roles rather than silently falling back during full-history forks", () => {
    expect(resolveSpawnAgent(undefined, true, "unknown")).toEqual({
      error: "Unknown inherited agent_type 'unknown'.",
    });
    expect(resolveSpawnAgent(undefined, true, " explorer ")).toMatchObject({
      agent: { type: "explorer", matched: true },
    });
    expect(resolveSpawnAgent(undefined, true, undefined)).toMatchObject({
      agent: { type: "default", matched: true },
    });
    expect(resolveSpawnAgent("", true, "worker")).toMatchObject({ agent: { type: "worker" } });
    expect(resolveSpawnAgent("worker", true, "worker")).toHaveProperty("error");
    expect(resolveSpawnAgent("unknown", false, "worker")).toHaveProperty("error");
    expect(resolveSpawnAgent(undefined, false, "unknown")).toMatchObject({
      agent: { type: "default", matched: true },
    });
  });

  it("exposes the Codex roles and defaults omitted roles", () => {
    expect(SUBAGENT_TYPES).toEqual(["default", "worker", "explorer"]);
    expect(resolveAgent()).toMatchObject({ type: "default", matched: true });
    expect(resolveAgent("worker")).toMatchObject({ type: "worker", matched: true });
    expect(resolveAgent("explorer")).toMatchObject({ type: "explorer", matched: true });
    expect(resolveAgent("nonexistent")).toMatchObject({ type: "default", matched: false });
  });

  it("keeps the embedded catalog immutable across extension instances", () => {
    expect(Object.isFrozen(DEFAULT_AGENTS)).toBe(true);
    expect(Object.isFrozen(DEFAULT_AGENTS.explorer)).toBe(true);
    expect(() => {
      (DEFAULT_AGENTS.explorer as { model?: string }).model = "provider/override";
    }).toThrow();
    expect(resolveAgent("explorer").config.model).toBeUndefined();
    expect(resolveAgent("explorer").config.thinking).toBeUndefined();
  });

  it.each(SUBAGENT_TYPES)("gives %s the inherited builtin baseline and extension", (type) => {
    const { config } = resolveAgent(type);

    expect(config.builtinToolNames).toEqual(["read", "bash", "edit", "write"]);
    expect(config.extensions).toEqual([expect.stringMatching(/\/index\.(ts|js)$/)]);
    expect(config.promptMode).toBe("append");
    expect(config.bashGatePolicy).toBe("prompt");
  });
});
