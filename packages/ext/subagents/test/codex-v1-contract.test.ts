import { describe, expect, it } from "vitest";
import {
  CODEX_V1_CONTRACT,
  CODEX_V1_NESTED_TOOLS,
  CODEX_V1_TOOL_NAMES,
} from "../codex-v1-contract.js";

describe("supported Codex V1 contract", () => {
  it("keeps flat direct identities and namespace-derived nested schemas aligned", () => {
    expect(Object.keys(CODEX_V1_CONTRACT.tools)).toEqual(CODEX_V1_TOOL_NAMES);
    for (const name of CODEX_V1_TOOL_NAMES) {
      const direct = CODEX_V1_CONTRACT.tools[name];
      const nested = CODEX_V1_NESTED_TOOLS.find((tool) => tool.tool_name.name === name)!;
      expect(direct.name).toBe(name);
      expect(nested.name).toBe(`multi_agent_v1__${name}`);
      expect(nested.tool_name.namespace).toBe(CODEX_V1_CONTRACT.namespace.name);
      expect(nested.input_schema).toEqual(direct.parameters);
      expect(nested.output_schema).toEqual(direct.output_schema);
    }
    const spawn = CODEX_V1_CONTRACT.tools.spawn_agent.parameters;
    const send = CODEX_V1_CONTRACT.tools.send_input.parameters;
    expect(spawn.required).toEqual(["message"]);
    expect(send.required).toEqual(["target", "message"]);
    expect(spawn.properties).not.toHaveProperty("items");
    expect(send.properties).not.toHaveProperty("items");
    expect(spawn.properties).not.toHaveProperty("service_tier");
  });
});
