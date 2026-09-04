import { describe, expect, it } from "vitest";
import { buildAgentPrompt } from "../prompts.js";
import type { AgentConfig } from "../types.js";

describe("buildAgentPrompt", () => {
  it.each(["append", "replace"] as const)(
    "tells %s-mode agents that they share the parent filesystem",
    (promptMode) => {
      const config: AgentConfig = {
        name: "worker",
        description: "test",
        builtinToolNames: [],
        extensions: [],
        systemPrompt: "Do the task.",
        promptMode,
      };

      const prompt = buildAgentPrompt(
        config,
        "/project",
        { isGitRepo: true, branch: "main", platform: "linux" },
        "Parent prompt.",
      );

      expect(prompt).toContain("Filesystem: shared with the parent session and other agents");
    },
  );
});
