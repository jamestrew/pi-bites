import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { createAdapterToolState, type AdapterToolState } from "./activation.js";

const ENTRY = "pi-bites:codex-tool-selection";
const schema = Type.Object({
  version: Type.Literal(1),
  tools: Type.Array(Type.String()),
  disabledVisible: Type.Array(Type.Literal("codemode")),
  projection: Type.Union([
    Type.Object({ kind: Type.Literal("inactive") }),
    Type.Object({
      kind: Type.Literal("active"),
      displaced: Type.Array(
        Type.Object({
          name: Type.Union([
            Type.Literal("read"),
            Type.Literal("bash"),
            Type.Literal("edit"),
            Type.Literal("write"),
          ]),
          index: Type.Integer({ minimum: 0 }),
          before: Type.Optional(Type.String()),
        }),
      ),
      visible: Type.Array(Type.Literal("codemode")),
    }),
  ]),
});

/** Permission metadata only: never restore shells, stores or runtime resources. */
export function createSelectionPersistence(pi: Pick<ExtensionAPI, "appendEntry">) {
  let previous: string | undefined;
  return {
    restore(ctx: ExtensionContext, permits: (name: string) => boolean): AdapterToolState {
      const entry = [...ctx.sessionManager.getBranch()]
        .reverse()
        .find((entry) => entry.type === "custom" && entry.customType === ENTRY);
      const data = entry?.type === "custom" ? entry.data : undefined;
      previous = undefined;
      if (!Value.Check(schema, data)) return createAdapterToolState();
      previous = JSON.stringify(data);
      return {
        selection: {
          tools: new Set(data.tools.filter(permits)),
          disabledVisible: new Set(data.disabledVisible),
        },
        projection:
          data.projection.kind === "inactive"
            ? { kind: "inactive" }
            : {
                kind: "active",
                displaced: data.projection.displaced.filter((tool) => permits(tool.name)),
                visible: new Set(data.projection.visible.filter(permits)),
                nested: new Set(),
              },
      };
    },
    save(state: AdapterToolState) {
      if (!state.selection) return;
      const data = {
        version: 1,
        tools: [...state.selection.tools],
        disabledVisible: [...state.selection.disabledVisible],
        projection:
          state.projection.kind === "inactive"
            ? { kind: "inactive" }
            : {
                kind: "active",
                displaced: state.projection.displaced,
                visible: [...state.projection.visible],
              },
      };
      const serialized = JSON.stringify(data);
      if (serialized === previous) return;
      pi.appendEntry(ENTRY, data);
      previous = serialized;
    },
  };
}
