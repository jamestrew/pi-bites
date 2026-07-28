import assert from "node:assert/strict";
import { test } from "vitest";

import {
  GOAL_TOOL_NAME_GUIDANCE,
  TOOL_PROMPT_GUIDELINES,
  budgetLimitPrompt,
  completionAuditContinuationPromptSection,
  completionAuditToolGuidelines,
  continuationGoalIdFromPrompt,
  continuationPrompt,
  goalToolReference,
  supersededContinuationMessage,
} from "../prompts.js";
import { createGoal } from "../state.js";

test("tool prompt guidelines include exposed and namespaced goal tool guidance", () => {
  assert.match(GOAL_TOOL_NAME_GUIDANCE, /available tool list/);
  assert.match(GOAL_TOOL_NAME_GUIDANCE, /pi__get_goal/);
  assert.match(GOAL_TOOL_NAME_GUIDANCE, /pi__create_goal/);
  assert.match(GOAL_TOOL_NAME_GUIDANCE, /pi__update_goal/);
  assert.match(
    GOAL_TOOL_NAME_GUIDANCE,
    /Do not assume display, history, or transcript tool names are callable/,
  );

  assert.equal(
    goalToolReference("update_goal"),
    "update_goal (or the exposed namespaced equivalent, such as pi__update_goal)",
  );

  const combined = TOOL_PROMPT_GUIDELINES.join("\n");
  assert.match(combined, /get_goal \(or the exposed namespaced equivalent, such as pi__get_goal\)/);
  assert.match(
    combined,
    /create_goal \(or the exposed namespaced equivalent, such as pi__create_goal\)/,
  );
  assert.match(
    combined,
    /update_goal \(or the exposed namespaced equivalent, such as pi__update_goal\)/,
  );
  for (const guideline of completionAuditToolGuidelines()) {
    assert.ok(TOOL_PROMPT_GUIDELINES.includes(guideline));
  }
  assert.match(combined, /same genuine blocker.*at least three consecutive goal turns/);
});

test("continuation prompt uses the canonical completion-audit contract", () => {
  const created = createGoal(null, "ship it", 10).goal;
  assert.ok(created);

  const continuation = continuationPrompt(created);
  assert.match(
    continuation,
    /Before deciding that the goal is achieved, perform a completion audit/,
  );
  assert.match(continuation, /prompt-to-artifact checklist/);
  assert.match(continuation, /Do not accept proxy signals as completion by themselves/);
  assert.match(
    continuation,
    /Do not mark a goal complete merely because the budget is nearly exhausted/,
  );
  assert.ok(continuation.includes(completionAuditContinuationPromptSection().join("\n")));
});

test("every continuation directly reinjects the objective and current state", () => {
  const created = createGoal(null, "ship <issue> & verify", 10).goal;
  assert.ok(created);
  created.usage = { tokensUsed: 4, activeSeconds: 65 };

  const prompt = continuationPrompt(created);
  assert.equal(continuationGoalIdFromPrompt(prompt), created.goalId);
  assert.match(prompt, /<pi_goal_continuation goal_id="/);
  assert.match(
    prompt,
    /<untrusted_objective>\nship &lt;issue&gt; &amp; verify\n<\/untrusted_objective>/,
  );
  assert.match(prompt, /Status: active/);
  assert.match(prompt, /Time spent pursuing goal: 1m/);
  assert.match(prompt, /Tokens used: 4/);
  assert.match(prompt, /Token budget: 10/);
  assert.match(prompt, /Tokens remaining: 6/);
  assert.match(prompt, /current worktree and external state as authoritative/);
  assert.match(prompt, /same genuine blocker.*at least three consecutive goal turns/);
});

test("superseded continuation bookkeeping does not expose a runnable marker", () => {
  const created = createGoal(null, "ship it", 10).goal;
  assert.ok(created);

  const superseded = supersededContinuationMessage(created.goalId);
  assert.equal(continuationGoalIdFromPrompt(superseded), null);
  assert.match(superseded, /Superseded hidden goal continuation bookkeeping/);
});

test("continuation and budget-limit prompts reference exposed goal-completion tool names", () => {
  const created = createGoal(null, "ship it", 10).goal;
  assert.ok(created);

  const continuation = continuationPrompt(created);
  const budget = budgetLimitPrompt(created);

  assert.match(budget, /marked the goal as budgetLimited/);
  assert.doesNotMatch(budget, /budget_limited/);

  for (const prompt of [continuation, budget]) {
    assert.match(
      prompt,
      /update_goal \(or the exposed namespaced equivalent, such as pi__update_goal\)/,
    );
    assert.match(prompt, /pi__update_goal/);
    assert.match(prompt, /Do not assume display, history, or transcript tool names are callable/);
  }
});
