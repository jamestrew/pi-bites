import assert from "node:assert/strict";
import { test } from "vitest";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { goalToolResponse } from "../format.js";
import { createGoal } from "../state.js";
import { registerGoalTools } from "../tools.js";
import type { ThreadGoal } from "../types.js";

const CODEX_REFERENCE_COMMIT = "3418498f01422f5f650ea645d4bd19e05c3a9616";

type RegisteredTool = Parameters<ExtensionAPI["registerTool"]>[0];

function registeredTools(): Map<string, RegisteredTool> {
  const tools = new Map<string, RegisteredTool>();
  const pi = {
    registerTool(tool: RegisteredTool) {
      tools.set(tool.name, tool);
    },
  } as unknown as ExtensionAPI;

  registerGoalTools(pi, {
    getGoal: () => null,
    setGoal: () => {},
    updateGoal: () => ({ ok: false, message: "unused", goal: null }),
  });
  return tools;
}

const CONTRACT_FIXTURES = [
  {
    name: "get_goal",
    description:
      "Get the current goal for this thread, including status, budgets, token and elapsed-time usage, and remaining token budget.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "create_goal",
    description:
      "Create a goal only when explicitly requested by the user or system/developer instructions; do not infer goals from ordinary tasks.\nSet token_budget only when an explicit token budget is requested. Fails if an unfinished goal exists; use update_goal only for status.",
    parameters: {
      type: "object",
      required: ["objective"],
      properties: {
        objective: {
          type: "string",
          description:
            "Required. The concrete objective to start pursuing. This starts a new active goal when no goal exists or replaces the current goal when it is complete.",
        },
        token_budget: {
          type: "integer",
          description: "Positive token budget for the new goal. Omit unless explicitly requested.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "update_goal",
    description:
      "Update the current Codex-style goal to complete or blocked. Mark complete only after an evidence-backed audit proves every requirement is achieved. Mark blocked only when the same genuine blocker has repeated for at least three consecutive goal turns; ordinary difficulty or a changed blocker does not qualify. This tool cannot pause, resume, limit usage or budget, or change the objective or budget.",
    parameters: {
      type: "object",
      required: ["status"],
      properties: {
        status: {
          type: "string",
          enum: ["complete", "blocked"],
          description:
            "Required. Mark complete only after verified completion. Mark blocked only after the same genuine blocker repeats for at least three consecutive goal turns.",
        },
      },
      additionalProperties: false,
    },
  },
] as const;

test(`goal tool schemas match Codex ${CODEX_REFERENCE_COMMIT}`, () => {
  const tools = registeredTools();

  for (const fixture of CONTRACT_FIXTURES) {
    const tool = tools.get(fixture.name);
    assert.ok(tool);
    assert.equal(tool.description, fixture.description);
    assert.deepEqual(tool.parameters, fixture.parameters);
  }
});

const INTERNAL_GOAL: ThreadGoal = {
  goalId: "internal-incarnation",
  objective: "ship it",
  status: "active",
  tokenBudget: 100,
  usage: { tokensUsed: 25, activeSeconds: 7 },
  createdAt: 1_700_000_000,
  updatedAt: 1_700_000_007,
};

const RESULT_FIXTURES = [
  {
    name: "null goal",
    actual: goalToolResponse(null, "thread-1"),
    expected: {
      goal: null,
      remainingTokens: null,
      completionBudgetReport: null,
    },
  },
  {
    name: "public goal",
    actual: goalToolResponse(INTERNAL_GOAL, "thread-1"),
    expected: {
      goal: {
        threadId: "thread-1",
        objective: "ship it",
        status: "active",
        tokenBudget: 100,
        tokensUsed: 25,
        timeUsedSeconds: 7,
        createdAt: 1_700_000_000,
        updatedAt: 1_700_000_007,
      },
      remainingTokens: 75,
      completionBudgetReport: null,
    },
  },
] as const;

test(`goal results match Codex ${CODEX_REFERENCE_COMMIT}`, () => {
  for (const fixture of RESULT_FIXTURES) {
    assert.deepEqual(fixture.actual, fixture.expected, fixture.name);
  }
});

test("token budgets reject non-positive, unsafe, fractional, and malformed values", () => {
  for (const value of [
    0,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    1e100,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    "10",
  ]) {
    assert.equal(createGoal(null, "ship it", value as number).ok, false, String(value));
  }
  assert.equal(createGoal(null, "ship it", Number.MAX_SAFE_INTEGER).ok, true);
  assert.equal(createGoal(null, "ship it").ok, true);
});
