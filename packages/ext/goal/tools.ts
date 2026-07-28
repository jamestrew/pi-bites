import { StringEnum } from "@earendil-works/pi-ai/compat";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { goalToolResponse, type GoalToolResponse } from "./format.js";
import { createGoal, isPositiveTokenBudget } from "./state.js";
import { TOOL_PROMPT_GUIDELINES } from "./prompts.js";
import type { GoalEntrySource, GoalResult, ThreadGoal } from "./types.js";

const EmptyParams = Type.Object({}, { additionalProperties: false, required: [] });

const CreateGoalParams = Type.Object(
  {
    objective: Type.String({
      description:
        "Required. The concrete objective to start pursuing. This starts a new active goal when no goal exists or replaces the current goal when it is complete.",
    }),
    token_budget: Type.Optional(
      Type.Integer({
        description: "Positive token budget for the new goal. Omit unless explicitly requested.",
      }),
    ),
  },
  { additionalProperties: false },
);

const UpdateGoalParams = Type.Object(
  {
    status: StringEnum(["complete"] as const, {
      description: "Only complete is accepted. Do not call this until no required work remains.",
    }),
  },
  { additionalProperties: false },
);

export interface ToolHost {
  getGoal(): ThreadGoal | null;
  setGoal(goal: ThreadGoal, source: GoalEntrySource, ctx: ExtensionContext): void;
  completeGoal(source: GoalEntrySource, ctx: ExtensionContext): GoalResult;
}

function toolResult(
  goal: ThreadGoal | null,
  threadId: string,
  includeCompletionBudgetReport = false,
): AgentToolResult<GoalToolResponse> {
  const details = goalToolResponse(goal, threadId, includeCompletionBudgetReport);
  return {
    content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
    details,
  };
}

function throwToolError(message: string): never {
  throw new Error(message);
}

function rejectUnknownProperties(params: object, allowed: readonly string[]): void {
  const unknown = Object.keys(params).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throwToolError(
      `Unknown goal tool propert${unknown.length === 1 ? "y" : "ies"}: ${unknown.join(", ")}`,
    );
  }
}

export function registerGoalTools(pi: ExtensionAPI, host: ToolHost): void {
  pi.registerTool({
    name: "get_goal",
    label: "Get Goal",
    description:
      "Get the current goal for this thread, including status, budgets, token and elapsed-time usage, and remaining token budget.",
    promptSnippet:
      "Inspect the current goal, status, token budget, tokens used, and active elapsed time.",
    promptGuidelines: TOOL_PROMPT_GUIDELINES,
    parameters: EmptyParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      rejectUnknownProperties(params, []);
      const goal = host.getGoal();
      const threadId = ctx.sessionManager.getSessionId();
      return toolResult(goal, threadId);
    },
  });

  pi.registerTool({
    name: "create_goal",
    label: "Create Goal",
    description:
      "Create a goal only when explicitly requested by the user or system/developer instructions; do not infer goals from ordinary tasks.\nSet token_budget only when an explicit token budget is requested. Fails if an unfinished goal exists; use update_goal only for status.",
    promptSnippet:
      "Create one goal with an objective and optional positive token budget. Fails when a non-complete goal already exists; replaces a completed goal.",
    promptGuidelines: TOOL_PROMPT_GUIDELINES,
    parameters: CreateGoalParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      rejectUnknownProperties(params, ["objective", "token_budget"]);
      if (typeof params.objective !== "string") {
        throwToolError("Objective must be a string.");
      }
      if (params.token_budget !== undefined && !isPositiveTokenBudget(params.token_budget)) {
        throwToolError("Token budget must be a positive integer.");
      }
      const current = host.getGoal();
      const result = createGoal(current, params.objective, params.token_budget ?? null);
      if (!result.ok || !result.goal) {
        throwToolError(result.message);
      }
      host.setGoal(result.goal, "tool", ctx);
      const threadId = ctx.sessionManager.getSessionId();
      return toolResult(result.goal, threadId);
    },
  });

  pi.registerTool({
    name: "update_goal",
    label: "Update Goal",
    description:
      "Mark the current Codex-style goal complete only after the objective is actually achieved and no required work remains. Do not use this tool just because work is stopping, budget is low, or partial progress looks sufficient.",
    promptSnippet:
      "Mark the current goal complete only after an evidence-backed completion audit proves no required work remains.",
    promptGuidelines: TOOL_PROMPT_GUIDELINES,
    parameters: UpdateGoalParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      rejectUnknownProperties(params, ["status"]);
      const result = host.completeGoal("tool", ctx);
      if (!result.ok || !result.goal) {
        throwToolError(result.message);
      }
      const threadId = ctx.sessionManager.getSessionId();
      return toolResult(result.goal, threadId, true);
    },
  });
}
