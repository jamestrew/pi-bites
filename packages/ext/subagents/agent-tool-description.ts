import { Type } from "typebox";
import { CODEX_V1_CONTRACT } from "./codex-v1-contract.js";

/** Build Pi's TypeBox form of the pinned spawn_agent parameter contract. */
export function getAgentToolParameters() {
  const properties = CODEX_V1_CONTRACT.tools.spawn_agent.parameters.properties;
  return Type.Object(
    {
      message: Type.String({ description: properties.message.description }),
      agent_type: Type.Optional(Type.String({ description: properties.agent_type.description })),
      fork_context: Type.Optional(
        Type.Boolean({ description: properties.fork_context.description }),
      ),
      model: Type.Optional(Type.String({ description: properties.model.description })),
      reasoning_effort: Type.Optional(
        Type.String({ description: properties.reasoning_effort.description }),
      ),
    },
    { additionalProperties: false },
  );
}
