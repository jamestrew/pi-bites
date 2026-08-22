import { beforeEach, describe, expect, it } from "vitest";
import {
  getAgentConfig,
  getAvailableTypes,
  getConfig,
  getMemoryToolNames,
  getReadOnlyMemoryToolNames,
  getUserAgentNames,
  isValidType,
  registerAgents,
} from "../agent-types.js";
import type { AgentConfig } from "../types.js";

function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "test-agent",
    description: "Test agent",
    builtinToolNames: ["read", "grep"],
    extensions: false,
    skills: false,
    systemPrompt: "You are a test agent.",
    promptMode: "replace",
    inheritContext: false,
    isolated: false,
    ...overrides,
  };
}

describe("agent type registry", () => {
  beforeEach(() => {
    registerAgents(new Map());
  });

  it("rejects unknown types", () => {
    expect(isValidType("nonexistent")).toBe(false);
    expect(isValidType("")).toBe(false);
  });

  it("configures the built-in general agent", () => {
    const config = getConfig("general");

    expect(config.builtinToolNames).toEqual(["read", "bash", "edit", "write"]);
    expect(config.extensions).toEqual([expect.stringMatching(/\/index\.(ts|js)$/)]);
    expect(config.skills).toBe(true);
    expect(config.promptMode).toBe("append");
  });

  it("scopes default explore to factual retrieval in the bundled extension", () => {
    const config = getConfig("explore");
    const agent = getAgentConfig("explore");

    expect(config.builtinToolNames).toEqual(["read", "ls", "bash"]);
    expect(config.extensions).toEqual([expect.stringMatching(/\/index\.(ts|js)$/)]);
    expect(agent?.description).toContain("files, symbols, definitions, references, call paths");
    expect(agent?.description).toContain("Do not delegate code review");
    expect(agent?.description).toContain("root-cause analysis");
    expect(agent?.systemPrompt).toContain("Do not perform code review");
    expect(agent?.systemPrompt).toContain(
      "Treat the working directory you were given as the default search root",
    );
    expect(agent?.systemPrompt).toContain(
      "explicitly delegates another path, repository, or checkout",
    );
    expect(agent?.systemPrompt).toContain("including an absolute path outside that directory");
    expect(agent?.systemPrompt).toContain(
      "When no alternate location is supplied, keep searches rooted in the assigned working directory",
    );
    expect(agent?.systemPrompt).toContain(
      "Do not roam unrelated directories or broaden the task beyond the paths and question supplied by the parent",
    );
    expect(agent?.systemPrompt).not.toContain(
      "read or search files outside the working directory you were given",
    );
    expect(agent?.bashGatePolicy).toBe("prompt");
  });

  describe("user agents", () => {
    it("registers and retrieves user agents", () => {
      registerAgents(
        new Map([["auditor", makeAgentConfig({ name: "auditor", description: "Auditor" })]]),
      );

      expect(isValidType("auditor")).toBe(true);
      expect(getAgentConfig("auditor")?.description).toBe("Auditor");
    });

    it("includes user agents in available types", () => {
      registerAgents(new Map([["auditor", makeAgentConfig({ name: "auditor" })]]));

      expect(getAvailableTypes()).toContain("auditor");
    });

    it("lists user agent names separately", () => {
      registerAgents(
        new Map([
          ["auditor", makeAgentConfig({ name: "auditor" })],
          ["reviewer", makeAgentConfig({ name: "reviewer" })],
        ]),
      );

      expect(getUserAgentNames()).toEqual(["auditor", "reviewer"]);
    });

    it("getConfig returns config for user agents", () => {
      registerAgents(
        new Map([
          [
            "auditor",
            makeAgentConfig({
              name: "auditor",
              description: "Security auditor",
              builtinToolNames: ["read", "grep"],
              extensions: false,
              skills: true,
            }),
          ],
        ]),
      );

      const config = getConfig("auditor");
      expect(config.displayName).toBe("auditor");
      expect(config.description).toBe("Security auditor");
      expect(config.builtinToolNames).toEqual(["read", "grep"]);
      expect(config.extensions).toBe(false);
      expect(config.skills).toBe(true);
    });

    it("clearing user agents works", () => {
      registerAgents(new Map([["auditor", makeAgentConfig({ name: "auditor" })]]));
      expect(isValidType("auditor")).toBe(true);

      registerAgents(new Map());
      expect(isValidType("auditor")).toBe(false);
    });

    it("disabled agent is excluded from available types", () => {
      registerAgents(new Map([["auditor", makeAgentConfig({ name: "auditor", enabled: false })]]));

      expect(isValidType("auditor")).toBe(false);
      expect(getAvailableTypes()).not.toContain("auditor");
    });
  });

  describe("getMemoryToolNames", () => {
    it("returns read, write, edit when none exist", () => {
      expect(getMemoryToolNames(new Set())).toEqual(["read", "write", "edit"]);
    });

    it("skips tools that already exist", () => {
      expect(getMemoryToolNames(new Set(["read", "edit"]))).toEqual(["write"]);
    });
  });

  describe("getReadOnlyMemoryToolNames", () => {
    it("returns only read when missing", () => {
      expect(getReadOnlyMemoryToolNames(new Set())).toEqual(["read"]);
    });

    it("returns empty when read already exists", () => {
      expect(getReadOnlyMemoryToolNames(new Set(["read"]))).toEqual([]);
    });
  });
});
