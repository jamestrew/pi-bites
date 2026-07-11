import type { Model, ThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BitesConfig } from "./config.js";
import { resolveModel } from "./subagents/model-resolver.js";

export const DEFAULT_SMALL_MODEL = "github-copilot/claude-haiku-4.5";
export const DEFAULT_SMALL_MODEL_THINKING: ThinkingLevel = "low";

export interface SmallModel {
  model: Model<any>;
  thinking: ThinkingLevel;
}

/** Resolve the configured cheap model, falling back to the current session model. */
export function getSmallModel(config: BitesConfig, ctx: ExtensionContext): SmallModel {
  const requested = config.smallModel?.model ?? DEFAULT_SMALL_MODEL;
  const resolved = resolveModel(requested, ctx.modelRegistry);
  const model = typeof resolved === "string" ? ctx.model : resolved;

  if (!model) throw new Error(resolved);

  return {
    model,
    thinking: config.smallModel?.thinking ?? DEFAULT_SMALL_MODEL_THINKING,
  };
}
