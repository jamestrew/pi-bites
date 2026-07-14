import type { Api, Model, ThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BitesConfig } from "./config.js";
import { resolveModel } from "./subagents/model-resolver.js";

export const DEFAULT_SMALL_MODEL = "github-copilot/claude-haiku-4.5";
export const DEFAULT_SMALL_MODEL_THINKING: ThinkingLevel = "low";

export interface SmallModel {
  model: Model<Api>;
  thinking: ThinkingLevel;
}

/** Resolve the configured cheap model, falling back to the current session model. */
export function getSmallModel(config: BitesConfig, ctx: ExtensionContext): SmallModel {
  const requested = config.smallModel?.model ?? DEFAULT_SMALL_MODEL;
  const resolved = resolveModel(requested, ctx.modelRegistry);
  const model =
    typeof resolved === "string"
      ? ctx.model && ctx.modelRegistry.find(ctx.model.provider, ctx.model.id)
      : resolved;

  if (!model) throw new Error(typeof resolved === "string" ? resolved : "Missing model");

  return {
    model,
    thinking: config.smallModel?.thinking ?? DEFAULT_SMALL_MODEL_THINKING,
  };
}
