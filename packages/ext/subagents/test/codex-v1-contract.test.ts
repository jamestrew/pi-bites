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
      "27948111f62cff69dab3c24c2c18eaf4bfdfc19028c568532cf9ced8906e62ef",
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

  it("records the plain-text, no-history pi adaptations", () => {
    const spawn = CODEX_V1_CONTRACT.tools.spawn_agent.parameters;
    const send = CODEX_V1_CONTRACT.tools.send_input.parameters;

    expect(spawn.required).toEqual(["message"]);
    expect(spawn.properties).not.toHaveProperty("items");
    expect(spawn.properties).not.toHaveProperty("fork_context");
    expect(send.required).toEqual(["target", "message"]);
    expect(send.properties).not.toHaveProperty("items");
  });

  it("measures the complete serialized contract conservatively", () => {
    const serialized = serializeCodexV1Contract();

    for (const field of ["name", "description", "parameters", "output_schema"] as const) {
      expect(serialized).toContain(`"${field}"`);
    }
    expect(serialized).toContain("Available roles:");
    expect(estimateCodexV1ContractTokens()).toBe(1_803);
    expect(CODEX_V1_TOKEN_BUDGET).toEqual({ currentBaseline: 1_605, softFinal: 2_000 });
    expect(estimateCodexV1ContractTokens()).toBeLessThanOrEqual(CODEX_V1_TOKEN_BUDGET.softFinal);
  });

  it("does not register the future surface yet", () => {
    expect(Object.values(SUBAGENT_TOOL_NAMES)).toEqual(["Agent", "WaitAgent", "MessageAgent"]);
  });
});
