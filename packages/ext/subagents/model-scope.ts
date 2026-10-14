import type { Api, Model } from "@earendil-works/pi-ai";
import type { SubagentContext } from "./operation-context.js";
import type { AgentRecord } from "./types.js";

type ScopeContext = Pick<SubagentContext, "modelRegistry" | "scopedModels" | "getAllowedModels">;
type ModelIdentity = Pick<Model<Api>, "provider" | "id">;

/** Empty native scope is unrestricted, but never grants unauthenticated models. */
export function allowedSubagentModels(ctx: ScopeContext): Model<Api>[] {
  if (ctx.getAllowedModels) return ctx.getAllowedModels();
  const available = ctx.modelRegistry.getAvailable();
  return ctx.scopedModels.length
    ? available.filter((model) =>
        ctx.scopedModels.some(({ model: scoped }) => sameModel(model, scoped)),
      )
    : available;
}

function sameModel(a: ModelIdentity, b: ModelIdentity): boolean {
  return a.provider === b.provider && a.id === b.id;
}

export function assertSubagentModel(model: ModelIdentity | undefined, allowed: Model<Api>[]): void {
  if (!model || allowed.some((entry) => sameModel(model, entry))) return;
  throw new Error(
    `Model not in scope: "${model.provider}/${model.id}".\n\nAllowed authenticated models (from session scope):\n${allowed
      .map((entry) => `  ${entry.provider}/${entry.id}`)
      .sort()
      .join("\n")}`,
  );
}

export function assertAgentModel(record: AgentRecord, allowed: Model<Api>[] | undefined): void {
  if (!allowed) return;
  const name = record.invocation.modelName;
  const model =
    record.session?.model ??
    (name
      ? { provider: name.slice(0, name.indexOf("/")), id: name.slice(name.indexOf("/") + 1) }
      : undefined);
  if (!model) throw new Error("No retained model is available for this agent.");
  assertSubagentModel(model, allowed);
}
