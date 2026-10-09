import { Type, type Static } from "typebox";
import * as Value from "typebox/value";

export const SUBAGENT_METADATA_ENTRY = "pi-bites:subagent";

export const SubagentMetadataSchema = Type.Object({
  agentId: Type.Optional(Type.String()),
  agentSessionId: Type.Optional(Type.String()),
  type: Type.String(),
  title: Type.String(),
  bashGatePolicy: Type.Optional(Type.Union([Type.Literal("deny"), Type.Literal("prompt")])),
});

export type SubagentMetadata = Static<typeof SubagentMetadataSchema>;

export function parseSubagentMetadata(value: unknown): SubagentMetadata | undefined {
  return Value.Check(SubagentMetadataSchema, value) ? value : undefined;
}
