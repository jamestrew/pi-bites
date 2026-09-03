import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext, ProviderConfig } from "@earendil-works/pi-coding-agent";

/** Session data a spawned agent may safely use after its parent context becomes stale. */
export interface ParentSnapshot {
  cwd: string;
  sessionId: string;
  systemPrompt: string;
  model?: Model<Api>;
  availableModels: Model<Api>[];
  providers: Array<[string, ProviderConfig]>;
}

export function snapshotParent(ctx: ExtensionContext): ParentSnapshot {
  const registry = ctx.modelRegistry;
  const providers: Array<[string, ProviderConfig]> = [];
  for (const id of registry.getRegisteredProviderIds()) {
    const config = registry.getRegisteredProviderConfig(id);
    if (config) providers.push([id, config]);
  }
  return {
    cwd: ctx.cwd,
    sessionId: ctx.sessionManager.getSessionId(),
    systemPrompt: ctx.getSystemPrompt(),
    model: ctx.model,
    availableModels: registry.getAvailable(),
    providers,
  };
}
