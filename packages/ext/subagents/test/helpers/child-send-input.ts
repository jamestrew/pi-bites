import { randomUUID } from "node:crypto";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { RunOptions } from "../../agent-runner.js";

/** Exercise the same registered operation exposed to a child model. */
export function registerChildSendInput(options: RunOptions, parentCtx: ExtensionContext) {
  const tools = new Map<string, ToolDefinition>();
  const childPi = {
    ...options.pi,
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    on: () => () => {},
  } as RunOptions["pi"];
  const target = parentCtx.sessionManager.getSessionId();
  const childSessionId = randomUUID();
  const childCtx = {
    ...parentCtx,
    sessionManager: {
      ...parentCtx.sessionManager,
      getSessionId: () => childSessionId,
    },
  } as ExtensionContext;
  if (!options.registerCollaboration) throw new Error("Missing child collaboration registrar");
  options.registerCollaboration(childPi, () => ["send_input"]).registerTools();
  const sendInput = tools.get("send_input");
  if (!sendInput) throw new Error("Child send_input was not registered");
  return (message: string) =>
    sendInput.execute(randomUUID(), { target, message }, undefined, undefined, childCtx);
}
