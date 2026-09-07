import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CODEX_V1_AGENT_STATUSES,
  CODEX_V1_CONTRACT,
  CODEX_V1_SOURCE_PATHS,
  CODEX_V1_TOKEN_BUDGET,
  CODEX_V1_TOOL_NAMES,
  CODEX_V1_UPSTREAM_REVISION,
  estimateCodexV1ContractTokens,
  serializeCodexV1Contract,
} from "../codex-v1-contract.js";
import { SUBAGENT_TOOL_NAMES } from "../agent-runner.js";

describe("Codex V1 subagent contract", () => {
  it("pins the authoritative upstream revision and sources", () => {
    expect(CODEX_V1_UPSTREAM_REVISION).toBe("ddf8a67ab09cd76b8adc0969f11ee1271179aba7");
    expect(CODEX_V1_SOURCE_PATHS).toEqual([
      "codex-rs/core/src/tools/handlers/multi_agents_spec.rs",
      "codex-rs/core/src/tools/handlers/multi_agents.rs",
      "codex-rs/core/src/tools/handlers/multi_agents_common.rs",
      "codex-rs/core/src/tools/handlers/multi_agents/spawn.rs",
      "codex-rs/core/src/tools/handlers/multi_agents/send_input.rs",
      "codex-rs/core/src/tools/handlers/multi_agents/wait.rs",
      "codex-rs/core/src/tools/handlers/multi_agents/close_agent.rs",
      "codex-rs/core/src/tools/handlers/multi_agents/resume_agent.rs",
      "codex-rs/core/src/session/multi_agents.rs",
      "codex-rs/core/src/agent/role.rs",
      "codex-rs/core/templates/collab/experimental_prompt.md",
    ]);
  });

  it("pins every model-facing tool field", () => {
    const serialized = serializeCodexV1Contract();

    expect(createHash("sha256").update(serialized).digest("hex")).toBe(
      "b7ce00fa797f6205c910a9659106552adc42b86063bd57997e8743bf990b378c",
    );
    expect(CODEX_V1_TOOL_NAMES).toEqual([
      "spawn_agent",
      "send_input",
      "wait_agent",
      "close_agent",
      "resume_agent",
    ]);
    expect(Object.keys(CODEX_V1_CONTRACT.tools)).toEqual(CODEX_V1_TOOL_NAMES);
    expect(CODEX_V1_AGENT_STATUSES).toEqual([
      "pending_init",
      "running",
      "interrupted",
      "shutdown",
      "not_found",
      "completed",
      "errored",
    ]);
  });

  it("keeps plain-text input while adopting Codex history-fork semantics", () => {
    const spawn = CODEX_V1_CONTRACT.tools.spawn_agent.parameters;
    const send = CODEX_V1_CONTRACT.tools.send_input.parameters;

    expect(spawn.required).toEqual(["message"]);
    expect(spawn.properties).not.toHaveProperty("items");
    expect(spawn.properties.fork_context).toEqual({
      type: "boolean",
      description:
        "True forks the current thread history into the new agent; false or omitted starts with only the initial prompt.",
    });
    expect(spawn.properties.agent_type.description).toContain(
      "Omit to inherit the parent agent type with a full-history fork; otherwise, `default` is used.",
    );
    expect(send.required).toEqual(["target", "message"]);
    expect(send.properties).not.toHaveProperty("items");
  });

  it("adopts Codex role permissions and lifecycle guidance", () => {
    expect(CODEX_V1_CONTRACT.roles.explorer).not.toContain("read-only");
    expect(CODEX_V1_CONTRACT.tools.close_agent.description).toContain(
      "Completed agents remain open and count toward the concurrency limit until closed.",
    );
    expect(CODEX_V1_CONTRACT.tools.wait_agent.description).toContain(
      "a notification message will be received containing the same completed status.",
    );
  });

  it("pins the full default Codex spawn guidance before optimizing its size", () => {
    const description = CODEX_V1_CONTRACT.tools.spawn_agent.description;

    expect(description).toContain("No picker-visible model overrides are currently loaded.");
    expect(description).toContain(
      "This spawn_agent tool provides you access to sub-agents that inherit your current model by default.",
    );
    expect(description).toContain("### When to delegate vs. do the subtask yourself");
    expect(description).toContain("### Designing delegated subtasks");
    expect(description).toContain("### After you delegate");
    expect(description).toContain("### Parallel delegation patterns");
  });

  it("measures the complete serialized contract conservatively", () => {
    const serialized = serializeCodexV1Contract();

    for (const field of ["name", "description", "parameters", "output_schema"] as const) {
      expect(serialized).toContain(`"${field}"`);
    }
    expect(serialized).toContain("Available roles:");
    expect(estimateCodexV1ContractTokens()).toBe(2_902);
    expect(CODEX_V1_TOKEN_BUDGET).toEqual({ currentBaseline: 1_605, softFinal: 2_000 });
    expect(estimateCodexV1ContractTokens()).toBeGreaterThan(CODEX_V1_TOKEN_BUDGET.softFinal);
  });

  it("activates the V1 spawn and send names without exposing the old Agent name", () => {
    expect(Object.values(SUBAGENT_TOOL_NAMES)).toEqual([
      "spawn_agent",
      "WaitAgent",
      "send_input",
      "MessageAgent",
    ]);
    expect(Object.values(SUBAGENT_TOOL_NAMES)).not.toContain("Agent");
  });
});
