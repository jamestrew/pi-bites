import type { SubagentPayload } from "./tool-result.js";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Static, TSchema } from "typebox";
import { getActiveSubagent } from "./subagent-context.js";

/** Only the dependencies used by owned collaboration operations, never a live Pi ctx. */
export interface SubagentContext {
  cwd: ExtensionContext["cwd"];
  model: ExtensionContext["model"];
  signal?: AbortSignal;
  scopedModels: ExtensionContext["scopedModels"];
  modelRegistry: Pick<
    ExtensionContext["modelRegistry"],
    "find" | "getAll" | "getAvailable" | "getRegisteredProviderIds" | "getRegisteredProviderConfig"
  >;
  sessionManager: Pick<ExtensionContext["sessionManager"], "getSessionId" | "buildContextEntries">;
  getSystemPrompt: () => string;
  ui: Pick<ExtensionContext["ui"], "notify">;
  thinking?: ReturnType<ExtensionAPI["getThinkingLevel"]>;
  allowedTools?: string[];
  parentRole?: string;
  scopeModels?: boolean;
}

export function captureSubagentContext(
  pi: ExtensionAPI,
  ctx: SubagentContext,
  forkContext = false,
  allowedTools = pi.getActiveTools(),
): SubagentContext {
  const registry = ctx.modelRegistry;
  const models = [...registry.getAvailable()];
  const providers = new Map(
    registry.getRegisteredProviderIds().map((id) => [id, registry.getRegisteredProviderConfig(id)]),
  );
  const sessionId = ctx.sessionManager.getSessionId();
  const entries = forkContext ? structuredClone(ctx.sessionManager.buildContextEntries()) : [];
  const systemPrompt = ctx.getSystemPrompt();
  const ui = ctx.ui;
  return {
    cwd: ctx.cwd,
    model: ctx.model,
    signal: ctx.signal,
    scopedModels: [...ctx.scopedModels],
    thinking: ctx.thinking ?? pi.getThinkingLevel(),
    allowedTools: [...allowedTools],
    parentRole: ctx.parentRole ?? getActiveSubagent(),
    modelRegistry: {
      getAvailable: () => models,
      getAll: () => models,
      find: (provider, id) =>
        models.find((model) => model.provider === provider && model.id === id),
      getRegisteredProviderIds: () => [...providers.keys()],
      getRegisteredProviderConfig: (id) => providers.get(id),
    },
    sessionManager: { getSessionId: () => sessionId, buildContextEntries: () => entries },
    getSystemPrompt: () => systemPrompt,
    ui: { notify: ui.notify.bind(ui) },
  };
}

/** Preserve Pi's definition/rendering types while narrowing the execution dependency. */
export function defineSubagentTool<P extends TSchema, D>(
  tool: Omit<ToolDefinition<P, D>, "execute"> & {
    execute: (
      callId: string,
      params: Static<P>,
      signal: AbortSignal | undefined,
      onUpdate: Parameters<ToolDefinition<P, D>["execute"]>[3],
      ctx: SubagentContext,
    ) => Promise<Awaited<ReturnType<ToolDefinition<P, D>["execute"]>> & { value: SubagentPayload }>;
  },
) {
  return tool;
}
