import { describe, expect, it } from "vitest";
import { resolveAgent } from "../agent-types.js";
import { DEFAULT_AGENTS } from "../default-agents.js";
import { SUBAGENT_TYPES } from "../types.js";

describe("embedded agent types", () => {
  it("exposes the Codex roles and defaults omitted roles", () => {
    expect(SUBAGENT_TYPES).toEqual(["default", "worker", "explorer"]);
    expect(resolveAgent()).toMatchObject({ type: "default", matched: true });
    expect(resolveAgent("WORKER")).toMatchObject({ type: "worker", matched: true });
    expect(resolveAgent("EXPLORER")).toMatchObject({ type: "explorer", matched: true });
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

  it("maps the write-capable behavior to worker", () => {
    const { config } = resolveAgent("worker");

    expect(config.builtinToolNames).toEqual(["read", "bash", "edit", "write"]);
    expect(config.extensions).toEqual([expect.stringMatching(/\/index\.(ts|js)$/)]);
    expect(config.promptMode).toBe("append");
  });

  it("keeps explorer read-only and scoped to factual retrieval", () => {
    const { config } = resolveAgent("explorer");

    expect(config.builtinToolNames).toEqual(["read", "ls", "bash"]);
    expect(config.extensions).toEqual([expect.stringMatching(/\/index\.(ts|js)$/)]);
    expect(config.description).toContain("files, symbols, definitions, references, call paths");
    expect(config.description).toContain("documentation or third-party source reading");
    expect(config.description).toContain("after 2-4 direct lookups fail");
    expect(config.description).toContain("known-path reads");
    expect(config.description).toContain("do not repeat its searches or reads while it runs");
    expect(config.description).toContain("continue only non-overlapping work");
    expect(config.description).toContain("Do not delegate code review");
    expect(config.description).toContain("root-cause analysis");
    expect(config.model).toBeUndefined();
    expect(config.thinking).toBeUndefined();
    expect(config.systemPrompt).toContain("Do not perform code review");
    expect(config.systemPrompt).toContain(
      "Treat the working directory you were given as the default search root",
    );
    expect(config.systemPrompt).toContain(
      "explicitly delegates another path, repository, or checkout",
    );
    expect(config.systemPrompt).toContain("including an absolute path outside that directory");
    expect(config.systemPrompt).toContain(
      "When no alternate location is supplied, keep searches rooted in the assigned working directory",
    );
    expect(config.systemPrompt).toContain(
      "Do not roam unrelated directories or broaden the task beyond the paths and question supplied by the parent",
    );
    expect(config.systemPrompt).not.toContain(
      "read or search files outside the working directory you were given",
    );
    expect(config.bashGatePolicy).toBe("prompt");
  });
});
