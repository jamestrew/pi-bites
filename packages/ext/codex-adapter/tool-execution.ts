import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Static, TSchema } from "typebox";

/** Stable dependencies consumed by the owned tools. A Pi context is compatible, but nested
 * execution constructs only this contract; adding a dependency requires updating the snapshot.
 */
export type ToolExecutionContext = Pick<
  ExtensionContext,
  "cwd" | "model" | "modelRegistry" | "isProjectTrusted"
>;

export type OwnedToolDefinition<P extends TSchema, D = unknown, S = unknown> = Omit<
  ToolDefinition<P, D, S>,
  "execute" | "prepareArguments"
> & {
  prepareArguments?(args: unknown): Static<P>;
  execute(
    toolCallId: Parameters<ToolDefinition<P, D, S>["execute"]>[0],
    params: Static<P>,
    signal: Parameters<ToolDefinition<P, D, S>["execute"]>[2],
    onUpdate: Parameters<ToolDefinition<P, D, S>["execute"]>[3],
    ctx: ToolExecutionContext,
  ): ReturnType<ToolDefinition<P, D, S>["execute"]>;
};
