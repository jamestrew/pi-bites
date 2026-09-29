import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
  type Api,
  type Model,
} from "@earendil-works/pi-ai";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import type { SubagentContext } from "./operation-context.js";
import { modelKey, resolveExactModel } from "./model-resolver.js";
import type { SubagentsSettings } from "./settings.js";
import { isThinkingLevel, type AgentConfig, type ThinkingLevel } from "./types.js";

/** Pi has no catalog default effort; use its fresh-session settings/default fallback. */
export function defaultThinking(model: Model<Api>, settings: SettingsManager): ThinkingLevel {
  return clampThinkingLevel(
    model,
    settings.getModelThinkingLevel(model.provider, model.id) ??
      settings.getDefaultThinkingLevel() ??
      "medium",
  );
}

export function resolveAgentInvocationConfig(
  agentConfig: AgentConfig,
  params: { model?: string; reasoning_effort?: string },
  ctx: Pick<
    SubagentContext,
    "cwd" | "model" | "modelRegistry" | "thinking" | "scopeModels" | "scopedModels" | "ui"
  >,
  defaults: Pick<SubagentsSettings, "defaultModel" | "defaultReasoningEffort"> = {},
) {
  const resolve = (input: string) => {
    const model = resolveExactModel(input, ctx.modelRegistry);
    if (typeof model === "string") throw new Error(model);
    return model;
  };
  const validateEffort = (model: Model<Api> | undefined, effort: string): ThinkingLevel => {
    if (!isThinkingLevel(effort)) throw new Error(`Unsupported reasoning_effort '${effort}'.`);
    if (model && !getSupportedThinkingLevels(model).includes(effort))
      throw new Error(
        `Unsupported reasoning_effort '${effort}' for '${model.provider}/${model.id}'. Supported: ${getSupportedThinkingLevels(model).join(", ")}.`,
      );
    return effort;
  };
  const checkScope = (model: Model<Api> | undefined, explicit: boolean, input?: string) => {
    if (!ctx.scopeModels || !model || !ctx.scopedModels.length) return;
    const allowed = new Set(ctx.scopedModels.map(({ model }) => modelKey(model)));
    if (allowed.has(modelKey(model))) return;
    const label = input ?? `${model.provider}/${model.id}`;
    if (explicit)
      throw new Error(
        `Model not in scope: "${label}".\n\nAllowed models (from session scope):\n${[...allowed]
          .sort()
          .map((name) => `  ${name}`)
          .join("\n")}`,
      );
    ctx.ui.notify(
      `Agent "${agentConfig.displayName ?? agentConfig.name}" using out-of-scope model "${label}"`,
      "warning",
    );
  };
  const requestedModel = params.model ?? defaults.defaultModel;
  const requestedEffort = params.reasoning_effort ?? defaults.defaultReasoningEffort;
  let model =
    requestedModel !== undefined ? resolve(requestedModel) : (ctx.model as Model<Api> | undefined);
  let thinking =
    requestedEffort !== undefined
      ? validateEffort(model, requestedEffort)
      : requestedModel !== undefined && model
        ? defaultThinking(model, SettingsManager.create(ctx.cwd))
        : model?.reasoning === false
          ? "off"
          : (ctx.thinking ?? "medium");

  checkScope(model, params.model !== undefined, requestedModel);

  // Codex validates requested/default settings before applying the selected role.
  // Full-history inherited roles have their model/effort fields cleared by the caller.
  if (agentConfig.model !== undefined) {
    model = resolve(agentConfig.model);
    checkScope(model, false, agentConfig.model);
  }
  if (agentConfig.thinking !== undefined) thinking = validateEffort(model, agentConfig.thinking);
  else if (agentConfig.model !== undefined) thinking = validateEffort(model, thinking);
  return { model, thinking };
}

/** Match Codex's five-entry advertised catalog; exact lookup still accepts every available model. */
export function describeSpawnModels(models: Model<Api>[], settings: SettingsManager): string {
  if (!models.length) return "No picker-visible model overrides are currently loaded.";
  const entries = models.slice(0, 5).map((model) => {
    const preferred = defaultThinking(model, settings);
    const efforts = getSupportedThinkingLevels(model)
      .map((effort) => (effort === preferred ? `${effort} (default)` : effort))
      .join(", ");
    return `- \`${model.provider}/${model.id}\`: ${model.name}. Reasoning efforts: ${efforts}.`;
  });
  return `Available model overrides (optional; inherited parent model is preferred):\n${entries.join("\n")}`;
}
